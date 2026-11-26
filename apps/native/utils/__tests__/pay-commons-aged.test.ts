// @vitest-environment jsdom
/**
 * Pay the Commons: a held payment ages (core money-retry.ts; the class PR #3393's node table named open). The node forgets a
 * retry id REQUEST_ID_KEPT_DAYS (7) after it paid, so the screen sends a payment whose answer was lost again for a day from
 * its FIRST sending only. Past that it stops offering Try again, says the Ledger shows whether it went through, and Pay the
 * Commons asks again and sends a new payment with a new id: the node's answer is never last week's payment replayed and
 * read as this one done.
 *
 * The screen (app/pay-commons.tsx) is drawn for real and its own handlers run; the node is stubbed at utils/names-debts,
 * the dialog at utils/keyboard-alert (it opens at once and records its buttons). Only Date is faked, so the requests'
 * promises run as they do, except in the last test, which also fakes the screen's timer. React Native's host components are
 * plain tags (profile-events-words-harness.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

type Button = { text?: string; onPress?: () => unknown };
const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Button[], opened: [] as Array<{ title: string; message?: string; buttons: Button[] }> }));
vi.mock('react-native', async () => (await import('./profile-events-words-harness')).nativeMock(alerts));
vi.mock('../keyboard-alert', () => ({
    Alert: { alert: (title: string, message?: string, buttons?: Button[]) => { alerts.opened.push({ title, message, buttons: buttons ?? [] }); } },
}));
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    return { KeyboardAwareScrollView: ({ children }: { children?: unknown }) => h('div', null, children as any) };
});
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return { SafeAreaView: ({ children }: { children?: unknown }) => h('div', null, children as any), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
vi.mock('expo-router', () => ({
    router: { push: () => {}, replace: () => {}, back: () => {}, canGoBack: () => true },
    useLocalSearchParams: () => ({}),
    ErrorBoundary: () => null,
}));
vi.mock('@expo/vector-icons', async () => {
    const { createElement: h } = await import('react');
    return { MaterialCommunityIcons: ({ name }: { name: string }) => h('i', { 'data-icon': name }) };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
// A fresh id for every confirmed payment, as on a phone.
vi.mock('expo-crypto', async () => {
    const { randomUUID } = await import('node:crypto');
    return { randomUUID: () => randomUUID() };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: '9'.repeat(64), privateKey: '8'.repeat(64), callsign: 'Wren' } }) }));
vi.mock('../node-post', () => ({ anchorUrl: async () => 'https://node.example', signedGet: vi.fn(), signedPost: vi.fn() }));
/** The node: every payment it is sent (the very object the screen handed it), and its answers in turn. */
type Sent = { requestId: string; body: { amount_c: number; requestId: string } };
const node = vi.hoisted(() => ({ payments: [] as Sent[], answers: [] as unknown[] }));
vi.mock('../names-debts', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    fetchMyRepayment: vi.fn(async () => ({ ok: true, value: null })),
    payTheCommons: vi.fn(async (_node: string, _who: unknown, payment: Sent) => {
        node.payments.push(payment);
        return node.answers.shift() ?? { ok: true, value: { transactionId: `tx-${node.payments.length}`, amount_c: payment.body.amount_c } };
    }),
}));

import PayCommonsScreen from '../../app/pay-commons';
import { REPAYMENT_LINES } from '../../components/repayment-lines';
import { PAY_UNANSWERED, PAY_UNANSWERED_RETRY } from '../names-debts';
import { payAgedLine } from '@beanpool/core';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 27, 9, 0, 0);
/** What payTheCommons answers when no answer came (names-debts.test.ts holds it to that): unanswered, so the screen holds it. */
const LOST = { ok: false, status: 0, message: PAY_UNANSWERED };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons = [];
    alerts.opened.length = 0;
    node.payments.length = 0;
    node.answers.length = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
/** The screen as the app draws it; called again, it is the same screen drawn again later. */
const draw = async () => { await act(async () => { root.render(createElement(PayCommonsScreen) as any); }); await settle(); };
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '') === label) ?? null;
const tap = async (label: string) => {
    const el = button(label);
    expect(el, `the ${label} button`).toBeTruthy();
    await act(async () => { el!.click(); });
    await settle();
};
const typeAmount = async (text: string) => {
    const input = host.querySelector('[aria-label="How many Beans"]') as HTMLInputElement | null;
    expect(input, 'the Beans field').toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};
/** The member taps Pay in the dialog that is showing (the last one opened). */
const payInDialog = async () => {
    const pay = alerts.opened.at(-1)?.buttons.find((b) => b.text === 'Pay');
    expect(pay, 'a Pay button in the dialog').toBeTruthy();
    await act(async () => { await pay!.onPress?.(); });
    await settle();
};
/** 7 Beans paid at T0 and the answer lost: the screen holds the payment for Try again. */
const lostAtT0 = async () => {
    node.answers.push(LOST);
    await draw();
    await typeAmount('7');
    await tap(REPAYMENT_LINES.payTitle);
    await payInDialog();
    expect(host.textContent).toContain(PAY_UNANSWERED_RETRY);
    expect(button('Try again')).not.toBeNull();
    expect(node.payments).toHaveLength(1);
    expect(alerts.opened).toHaveLength(1);
};
const later = async (age: number) => { vi.setSystemTime(T0 + age); await draw(); };

describe('Pay the Commons: Try again for a day from the first sending, never after', () => {
    for (const [name, age] of [['just after', 1000], ['23 hours later', 23 * H]] as const) {
        it(`${name}: Try again sends the very same payment, no new question`, async () => {
            await lostAtT0();
            await later(age);
            expect(host.textContent).not.toContain(payAgedLine());
            await tap('Try again');
            expect(node.payments).toHaveLength(2);
            expect(node.payments[1]).toBe(node.payments[0]);
            expect(alerts.opened).toHaveLength(1);
            expect(host.textContent).toContain('Paid');
        });
    }

    for (const [name, age] of [['25 hours later', 25 * H], ['8 days later (the node has forgotten its id)', 8 * 24 * H]] as const) {
        it(`${name}: no Try again; the aged line says to see the Ledger; Pay the Commons asks again and sends a NEW id`, async () => {
            await lostAtT0();
            await later(age);
            expect(button('Try again')).toBeNull();
            expect(host.textContent).toContain(payAgedLine());
            // The lost-answer line promised Try again and "never paid twice": it gives way to the aged line.
            expect(host.textContent).not.toContain(PAY_UNANSWERED_RETRY);
            expect(host.textContent).not.toMatch(/never paid twice/);
            expect(node.payments).toHaveLength(1);
            await tap(REPAYMENT_LINES.payTitle);
            expect(alerts.opened).toHaveLength(2);
            expect(alerts.opened[1].title).toBe(REPAYMENT_LINES.payTitle);
            expect(node.payments).toHaveLength(1);
            await payInDialog();
            expect(node.payments).toHaveLength(2);
            expect(node.payments[1].body.amount_c).toBe(700);
            expect(node.payments[1].requestId).not.toBe(node.payments[0].requestId);
            expect(node.payments[1].body.requestId).toBe(node.payments[1].requestId);
            expect(host.textContent).toContain('Paid');
            expect(host.textContent).not.toContain(payAgedLine());
        });
    }

    it('sent again at 23 hours and lost again, it keeps its FIRST stamp: at 25 hours it has aged', async () => {
        await lostAtT0();
        await later(23 * H);
        node.answers.push(LOST);
        await tap('Try again');
        expect(node.payments).toHaveLength(2);
        expect(node.payments[1]).toBe(node.payments[0]);
        expect(button('Try again')).not.toBeNull();
        await later(25 * H);
        expect(button('Try again')).toBeNull();
        expect(host.textContent).toContain(payAgedLine());
    });

    it('aged, changing the amount keeps the aged line up and offers no Try again; cancelling the question sends nothing', async () => {
        await lostAtT0();
        await later(25 * H);
        await typeAmount('8');
        expect(host.textContent).toContain(payAgedLine());
        expect(button('Try again')).toBeNull();
        await tap(REPAYMENT_LINES.payTitle);
        const cancel = alerts.opened.at(-1)!.buttons.find((b) => b.text === 'Cancel');
        expect(cancel).toBeTruthy();
        expect(node.payments).toHaveLength(1);
    });

    it('a screen left open draws itself again the moment the payment ages: Try again goes without a tap', async () => {
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(T0);
        await lostAtT0();
        expect(vi.getTimerCount(), 'the screen set its timer for the moment the payment ages').toBe(1);
        await act(async () => { vi.advanceTimersByTime(24 * H - 60_000); });
        expect(button('Try again')).not.toBeNull();
        await act(async () => { vi.advanceTimersByTime(60_000); });
        expect(button('Try again')).toBeNull();
        expect(host.textContent).toContain(payAgedLine());
    });
});
