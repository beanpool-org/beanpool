// @vitest-environment jsdom
/**
 * Pay the Commons can't be confirmed twice from a double tap (4 Nov Opus review of #2804, round 2).
 *
 * With the keyboard up, an Alert from utils/keyboard-alert waits (up to ~400 ms) for the keyboard to close, and the Pay
 * button behind it still takes taps (keyboardShouldPersistTaps="handled"; `busy` is set only once a dialog's Pay is
 * tapped). Each dialog's Pay mints a fresh payment id (confirmCommonsPayment), so two dialogs meant two payments: the member
 * pays in the first, sees the same dialog still there, and pays again. The helper now drops an identical Alert while one is
 * waiting.
 *
 * The screen (app/pay-commons.tsx) is drawn for real and its own Pay handler runs; so does the helper's logic
 * (makeKeyboardAlert). Only keyboard-controller is stood in for, at the helper's seam (its native side doesn't load in
 * node): a keyboard that is up and whose hide this test reports. React Native's host components are plain tags
 * (profile-events-words-harness.ts); the node is stubbed at utils/names-debts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

type Button = { text?: string; onPress?: () => unknown };
const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Button[], opened: [] as Array<{ title: string; message?: string; buttons: Button[] }> }));
vi.mock('react-native', async () => {
    const native = (await import('./profile-events-words-harness')).nativeMock(alerts);
    return {
        ...native,
        Alert: {
            alert: (title: string, message?: string, buttons?: Button[]) => {
                alerts.opened.push({ title, message, buttons: buttons ?? [] });
                native.Alert.alert(title, message, buttons);
            },
        },
    };
});

/** The keyboard: up, and its hide reported when the test says so. */
const kb = vi.hoisted(() => ({ visible: true, hides: 0, hide: Promise.resolve(), finish: () => {} }));
vi.mock('../keyboard-alert', async (importOriginal) => {
    const real = await importOriginal<typeof import('../keyboard-alert')>();
    const rn = await import('react-native');
    return {
        ...real,
        Alert: real.makeKeyboardAlert({
            openAlert: (...a: any[]) => (rn.Alert.alert as (...x: any[]) => void)(...a),
            keyboard: () => ({ isVisible: () => kb.visible, dismiss: () => { kb.hides += 1; return kb.hide; } }),
            blurNow: () => {},
            // Long enough that only the reported hide opens the Alert here, however slow the machine.
            timeoutMs: 10_000,
        }),
    };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    const pass = ({ children }: { children?: unknown }) => h('div', null, children as any);
    return { KeyboardAwareScrollView: pass };
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
// A fresh id for every confirmed payment, as on a phone: the same-id retry check can't merge two confirms.
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
/** The node: every payment it is sent. */
const node = vi.hoisted(() => ({ payments: [] as Array<{ requestId: string; body: { amount: number } }> }));
vi.mock('../names-debts', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    fetchMyRepayment: vi.fn(async () => ({ ok: true, value: null })),
    payTheCommons: vi.fn(async (_node: string, _who: unknown, payment: { requestId: string; body: { amount: number } }) => {
        node.payments.push(payment);
        return { ok: true, value: { transactionId: `tx-${node.payments.length}`, amount: payment.body.amount } };
    }),
}));

import PayCommonsScreen from '../../app/pay-commons';
import { REPAYMENT_LINES } from '../../components/repayment-lines';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons = [];
    alerts.opened.length = 0;
    node.payments.length = 0;
    kb.visible = true;
    kb.hides = 0;
    kb.hide = new Promise<void>((r) => { kb.finish = r; });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** The screen as the app draws it (JSX the app's Babel builds; createElement here). */
const draw = async () => { await act(async () => { root.render(createElement(PayCommonsScreen) as any); }); await settle(); };
const payButton = () => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '') === REPAYMENT_LINES.payTitle) ?? null;
const tap = async (el: Element | null) => {
    expect(el, 'the Pay button').toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
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
/** The member taps Pay in every dialog that is showing, one after the other, each payment answered before the next tap. */
const payInEveryDialog = async () => {
    for (const dialog of [...alerts.opened]) {
        const pay = dialog.buttons.find((b) => b.text === 'Pay');
        expect(pay, 'a Pay button in the dialog').toBeTruthy();
        await act(async () => { await pay!.onPress?.(); });
        await settle();
    }
};

describe('Pay the Commons: a double tap on Pay with the keyboard up', () => {
    it('opens one "Pay N Beans?" dialog, and so sends one payment', async () => {
        await draw();
        await typeAmount('5');
        await tap(payButton());
        await tap(payButton()); // the second tap lands while the first dialog waits for the keyboard to close
        await settle(4);
        expect(alerts.opened).toHaveLength(0); // still waiting for the hide: nothing over the closing keyboard
        kb.finish();
        await settle();
        await payInEveryDialog();
        expect(node.payments.map((p) => p.body.amount)).toEqual([5]); // one payment, not one per dialog
        expect(alerts.opened.map((d) => d.title)).toEqual([REPAYMENT_LINES.payTitle]);
        expect(alerts.opened[0].message).toContain('5');
        expect(kb.hides).toBe(1); // the second tap did not start a wait of its own
        expect(host.textContent).toContain('Paid');
    });

    it('a later, separate Pay (after the first dialog was cancelled) still asks again', async () => {
        await draw();
        await typeAmount('5');
        await tap(payButton());
        kb.finish();
        await settle();
        expect(alerts.opened).toHaveLength(1);
        const cancel = alerts.opened[0].buttons.find((b) => b.text === 'Cancel');
        expect(cancel).toBeTruthy();
        await act(async () => { await cancel!.onPress?.(); });
        kb.visible = false; // the keyboard is down now: the next dialog opens at once
        await tap(payButton());
        await settle();
        expect(alerts.opened).toHaveLength(2);
        expect(node.payments).toHaveLength(0);
    });
});
