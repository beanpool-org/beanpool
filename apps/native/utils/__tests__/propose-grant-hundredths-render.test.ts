// @vitest-environment jsdom
/**
 * A pool grant proposed on the phone (components/ProposeDecisionModal.tsx) goes to the node in whole hundredths of a Bean
 * (DESIGN-atomic-beans-fable.md M2): the amount typed in Beans is read by core parseHundredths and sent as
 * `params.amount_c`, the figure decisions-engine.ts takes. The old `params.amount` (Beans) is refused there, and a typed
 * "12.50" must never reach the node as 12.5 or as 12 hundredths.
 *
 * Rendered for real as propose-decision-words-render.test.ts renders it: react-dom in jsdom, React Native's host components
 * as plain tags, and a stubbed node behind utils/db.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => [] as Array<[string, string]>);
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled, value, onChangeText, placeholder, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (placeholder) attrs.placeholder = placeholder;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        KeyboardAvoidingView: el('div'),
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        Alert: { alert: (title: string, body: string) => { alerts.push([title, body]); } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});
const created = vi.hoisted(() => [] as unknown[]);
vi.mock('../db', () => ({
    createDecision: vi.fn(async (body: unknown) => { created.push(body); return { success: true }; }),
}));

import { amountRefusalWords } from '@beanpool/core';
import { ProposeDecisionModal } from '../../components/ProposeDecisionModal';

const ME = 'a'.repeat(64);
const ROOF = 'r'.repeat(64);
const NEIGHBOUR = 'n'.repeat(64);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    alerts.length = 0;
    created.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root.render(createElement(ProposeDecisionModal, {
            // The pot, whole hundredths: 1,000 Beans.
            isOpen: true, onClose: () => { }, onCreated: () => { },
            identity: { publicKey: ME, callsign: 'Me' }, commonsBalance: 100000, treasuries: [{ publicKey: ROOF, name: 'New hall roof', lifecycle: 'bounded' }], members: [],
        }) as unknown as Parameters<Root['render']>[0]);
    });
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const click = (node: Element | undefined | null) => { expect(node).toBeTruthy(); act(() => (node as HTMLElement).click()); };
const radio = (label: string) => Array.from(container.querySelectorAll('[role="radio"]')).find(r => r.textContent?.includes(label));
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent === label || b.getAttribute('aria-label') === label);
const type = (placeholder: string, value: string) => {
    const input = container.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null;
    expect(input, placeholder).toBeTruthy();
    act(() => { (input as any)[Object.keys(input!).find(k => k.startsWith('__reactProps'))!].onChange({ target: { value } }); });
};
const submit = async () => {
    const b = button('Submit Community Decision');
    expect(b).toBeTruthy();
    await act(async () => { (b as HTMLElement).click(); });
};

/** A grant to the roof project, `amount` typed in Beans. */
async function proposeGrant(amount: string) {
    click(button('Commons Pool'));
    click(radio('Give Beans to a project or enterprise'));
    type('e.g. Grant 200 beans to the Tool Library', 'Fund the roof');
    type('Explain why this decision is needed, what will be done, and who is responsible.', 'The hall leaks every winter');
    type('Enter its public key...', ROOF);
    type('e.g. 250', amount);
    await submit();
}

describe('a pool grant goes to the node in whole hundredths (params.amount_c)', () => {
    it.each([
        ['12.50', 1250],
        ['12.5', 1250],
        ['0.01', 1],
        ['49.25', 4925],
        ['500', 50000],
    ])('"%s" Beans is sent as amount_c %d, never as Beans', async (typed, amount_c) => {
        await proposeGrant(typed);
        expect(alerts.map(([title]) => title)).toEqual(['Decision Proposed']);
        expect(created).toEqual([expect.objectContaining({ touches: 'pool', effect: 'grant_enterprise', subject: ROOF, params: { amount_c } })]);
    });

    it('a third decimal is refused in words, and nothing is sent', async () => {
        await proposeGrant('12.505');
        expect(alerts).toEqual([['Invalid Amount', amountRefusalWords('too-many-decimals')]]);
        expect(created).toEqual([]);
    });

    it('nothing, or not a number, is refused, and nothing is sent', async () => {
        for (const typed of ['0', 'abc']) {
            alerts.length = 0;
            await proposeGrant(typed);
            expect(alerts.at(-1), typed).toEqual(['Invalid Amount', 'Please specify a valid grant amount in Beans.']);
        }
        expect(created).toEqual([]);
    });

    it('a hardship grant goes the same way: params.amount_c', async () => {
        click(button('Commons Pool'));
        click(radio('Hardship Grant'));
        type('e.g. Grant 200 beans to the Tool Library', 'Help after the flood');
        type('Explain why this decision is needed, what will be done, and who is responsible.', 'Their kitchen flooded in the storm');
        type('Enter recipient pubkey...', NEIGHBOUR);
        type('e.g. 100', '75.30');
        await submit();
        expect(created).toEqual([expect.objectContaining({ touches: 'pool', effect: 'grant_hardship', params: { amount_c: 7530 } })]);
    });
});
