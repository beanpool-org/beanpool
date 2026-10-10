// @vitest-environment jsdom
/**
 * The enterprise screen's Decisions block (components/EnterpriseDecisions.tsx) rendered for real: react-dom in jsdom,
 * React Native's host components as plain tags carrying their accessibility props and their flattened style, the real
 * light and dark palettes (constants/colors.ts) and @beanpool/core's words, and a stubbed node behind utils/db.
 *
 * Nothing here draws a frame (vitest.config.ts): what is checked is the tree, its words, and the style each element
 * is given, measured against the palette it is drawn on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScopedDecisionCard, ScopedDecisionList } from '@beanpool/core';
import { darkColors, lightColors } from '../../constants/colors';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled, value, onChangeText, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(accessibilityState.selected);
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        attrs['data-style'] = JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter(Boolean)));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const keyboard = vi.hoisted(() => ({ height: 0, isVisible: false }));
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: typeof keyboard) => unknown) => pick(keyboard),
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', { 'data-kav': 'true' }, children as any),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors: light, darkColors: dark } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: theme.dark ? dark : light }) };
});
const node = vi.hoisted(() => ({
    list: null as ScopedDecisionList | null,
    proposed: [] as unknown[],
    propose: null as null | ((body: unknown) => Promise<unknown>),
}));
vi.mock('../db', () => ({
    getEnterpriseDecisions: vi.fn(async () => node.list),
    proposeEnterpriseDecision: vi.fn(async (_t: string, body: unknown) => { node.proposed.push(body); return node.propose ? node.propose(body) : {}; }),
    voteEnterpriseDecision: vi.fn(async () => ({})),
}));

import { EnterpriseDecisions } from '../../components/EnterpriseDecisions';

const ENT = 'e'.repeat(64);
const ANN = 'a'.repeat(64), BOB = 'b'.repeat(64), CAT = 'c'.repeat(64);
const KEEPERS = [
    { publicKey: ANN, callsign: 'Ann', role: 'lead' },
    { publicKey: BOB, callsign: 'Bob', role: 'keeper' },
    { publicKey: CAT, callsign: 'Catherine-Rose', role: 'keeper' },
];

function card(over: Partial<ScopedDecisionCard> = {}): ScopedDecisionCard {
    return {
        id: 'd1', authorPubkey: ANN, title: 'Pay Bob for the oven', description: 'Bob fixed the oven door last week.',
        effect: 'pay_out', subject: BOB, params: { amount: 40 }, status: 'open',
        opensAt: new Date(Date.now() - 3600_000).toISOString(), closesAt: new Date(Date.now() + 6 * 86400_000).toISOString(),
        tally: { voted: 1, roll: 3, quorumRequired: 2, thresholdRequired: 0.6 }, myVote: null, ...over,
    };
}

let host: HTMLDivElement;
let root: Root;

async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i++) await act(async () => { await Promise.resolve(); });
}

async function render(props: Partial<Parameters<typeof EnterpriseDecisions>[0]> = {}) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(createElement(EnterpriseDecisions, {
            treasuryKey: ENT, myPubkey: BOB, keepers: KEEPERS, balance: 100, lifecycle: 'ongoing', ...props,
        }) as unknown as Parameters<Root['render']>[0]);
    });
    await settle();
}

const styleOf = (el: Element | null | undefined): Record<string, any> => JSON.parse(el?.getAttribute('data-style') || '{}');
const textEl = (re: RegExp) => Array.from(host.querySelectorAll('span')).find(s => re.test(s.textContent || '') && !Array.from(s.children).some(c => re.test(c.textContent || '')));
const press = async (el: Element | null | undefined) => {
    expect(el, 'the control is there').toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
const button = (re: RegExp) => Array.from(host.querySelectorAll('button')).find(b => re.test(b.getAttribute('aria-label') || b.textContent || ''));
const radio = (re: RegExp) => Array.from(host.querySelectorAll('[role=radio]')).find(r => re.test(r.textContent || ''));
const field = (label: string) => host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
async function type(label: string, text: string) {
    const input = field(label);
    expect(input, `the ${label} field`).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
}

/** WCAG contrast of two #rrggbb colours. */
function contrast(fg: string, bg: string): number {
    const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

beforeEach(() => {
    theme.dark = false;
    keyboard.height = 0;
    keyboard.isVisible = false;
    node.list = { decisions: [card()], canPropose: true, rollSize: 3 };
    node.proposed = [];
    node.propose = null;
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
});

describe('a vote card', () => {
    it("shows the proposer's Why? under what the vote does (design §2.5)", async () => {
        await render();
        expect(textEl(/^Pay 40 Beans to Bob$/)).toBeTruthy();
        expect(textEl(/^Bob fixed the oven door last week\.$/), "the proposer's words").toBeTruthy();
    });
});

describe('the pay-out form', () => {
    it('what it holds, rounded down to cents (review opus-1767 N8)', async () => {
        await render({ balance: 112.3125 });
        await press(button(/^Propose a vote$/));
        expect(textEl(/^It holds 112\.31 Beans now\.$/), textEl(/It holds/)?.textContent).toBeTruthy();
    });
});

describe('the propose sheet and the keyboard', () => {
    // components/useModalKeyboardLift.ts: a KeyboardAvoidingView inside an RN Modal collapsed a sheet to its title at
    // 320 dp; the sheet is lifted by the keyboard's height from the root provider's state instead.
    it('no KeyboardAvoidingView in the Modal; the sheet is lifted by the keyboard and fits what is left above it', async () => {
        await render();
        await press(button(/^Propose a vote$/));
        expect(host.querySelector('[data-modal]'), 'the sheet is open').toBeTruthy();
        expect(host.querySelector('[data-modal] [data-kav]'), 'no KeyboardAvoidingView inside the Modal').toBeNull();
        const down = styleOf(host.querySelector('[data-testid="propose-scoped-sheet"]'));
        expect(down.marginBottom ?? 0).toBe(0);
        expect(down.maxHeight).toBeCloseTo(569 * 0.92);
        await act(async () => { root.unmount(); });
        host.remove();

        keyboard.height = 300;
        keyboard.isVisible = true;
        await render();
        await press(button(/^Propose a vote$/));
        const up = styleOf(host.querySelector('[data-testid="propose-scoped-sheet"]'));
        expect(up.marginBottom).toBe(300);
        // The window less the keyboard and the gap kept under the status bar (inset 24 + 8).
        expect(up.maxHeight).toBe(569 - 300 - 32);
    });
});

describe("the propose form's error text", () => {
    for (const [name, palette] of [['light', lightColors], ['dark', darkColors]] as const) {
        it(`is drawn in the danger colour, readable on the sheet, in ${name}`, async () => {
            theme.dark = name === 'dark';
            await render();
            await press(button(/^Propose a vote$/));
            await press(radio(/^Catherine-Rose$/));
            await type('Amount in Beans', '500');
            const error = textEl(/so it can't pay more than that/);
            expect(error?.textContent).toBe("The enterprise holds 100 Beans, so it can't pay more than that.");
            const colour = styleOf(error).color;
            expect(typeof colour, `a colour, not ${JSON.stringify(colour)}`).toBe('string');
            expect(colour).toBe(palette.feedback.danger.fg);
            expect(contrast(colour, palette.surface.card)).toBeGreaterThanOrEqual(4.5);

            // The node's own refusal is drawn the same way.
            node.propose = async () => { throw new Error('Paying a keeper is a wage.'); };
            await type('Amount in Beans', '5');
            await type('Title', 'Pay Catherine-Rose');
            await type('Why', 'She fixed the oven door last week.');
            await press(button(/^Open the vote$/));
            const refusal = textEl(/^Paying a keeper is a wage\.$/);
            expect(styleOf(refusal).color).toBe(palette.feedback.danger.fg);
        });
    }
});
