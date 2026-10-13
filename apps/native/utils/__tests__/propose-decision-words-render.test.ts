// @vitest-environment jsdom
/**
 * The phone's propose-a-community-Decision form (components/ProposeDecisionModal.tsx) rendered for real: react-dom in
 * jsdom, React Native's host components as plain tags, @beanpool/core's words, and a stubbed node behind utils/db.
 *
 * Group decisions §3.1: the three effects that act on a project or an enterprise say so, a project picked under
 * "remove" names its leader (an enterprise its lead keeper), and no treasury or old effect name is shown.
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
    };
});
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

import { ProposeDecisionModal } from '../../components/ProposeDecisionModal';

const ME = 'a'.repeat(64);
const ROOF = 'r'.repeat(64), EGGS = 'e'.repeat(64);
const TREASURIES = [
    { publicKey: ROOF, name: 'New hall roof', lifecycle: 'bounded' },
    { publicKey: EGGS, name: 'Egg flock', lifecycle: 'ongoing' },
];

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
            isOpen: true, onClose: () => { }, onCreated: () => { },
            identity: { publicKey: ME, callsign: 'Me' }, commonsBalance: 100, treasuries: TREASURIES, members: [],
        }) as unknown as Parameters<Root['render']>[0]);
    });
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const text = () => container.textContent ?? '';
const click = (node: Element | undefined | null) => { expect(node).toBeTruthy(); act(() => (node as HTMLElement).click()); };
const radio = (label: string) => Array.from(container.querySelectorAll('[role="radio"]')).find(r => r.textContent?.includes(label));
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent === label || b.getAttribute('aria-label') === label);
const type = (placeholder: string, value: string) => {
    const input = container.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null;
    expect(input, placeholder).toBeTruthy();
    act(() => { (input as any)[Object.keys(input!).find(k => k.startsWith('__reactProps'))!].onChange({ target: { value } }); });
};
// The send is async: let it settle so the button is back before the next tap.
const submit = async () => {
    const b = button('Submit Community Decision');
    expect(b).toBeTruthy();
    await act(async () => { (b as HTMLElement).click(); });
};

describe('the phone propose-a-Decision form names projects and enterprises (§3.1)', () => {
    it('shows the three new effect labels and none of the old ones', () => {
        expect(radio('Remove a lead keeper or project leader')).toBeTruthy();
        click(button('Commons Pool'));
        expect(radio('Give Beans to a project or enterprise')).toBeTruthy();
        expect(radio("Pay off a project's or enterprise's debt")).toBeTruthy();
        click(button('Member'));
        for (const old of ['Remove Lead Keeper', 'Grant to Enterprise', 'Write Off Deficit', 'defaulted enterprise']) {
            expect(text()).not.toContain(old);
        }
        expect(text()).not.toMatch(/treasur/i);
    });

    it('a project picked under "remove" names its leader; an enterprise its lead keeper', () => {
        click(radio('Remove a lead keeper or project leader'));
        expect(text()).toContain('Project or enterprise');
        expect(text()).toContain('The lead keeper or leader to remove: callsign or public key');
        click(button('New hall roof'));
        expect(text()).toContain('The leader to remove: callsign or public key');
        expect(container.querySelector(`input[placeholder="Enter the leader's callsign or pubkey..."]`)).toBeTruthy();
        expect(text()).not.toContain('The lead keeper');
        click(button('Egg flock'));
        expect(text()).toContain('The lead keeper to remove: callsign or public key');
        expect(text()).not.toMatch(/treasur/i);
    });

    it('the alerts use the new words for a missing project or enterprise', async () => {
        click(radio('Remove a lead keeper or project leader'));
        type('e.g. Grant 200 beans to the Tool Library', 'Replace the roof lead');
        type('Explain why this decision is needed, what will be done, and who is responsible.', 'They left town');
        type("Enter the lead keeper or leader's callsign or pubkey...", 'b'.repeat(64));
        await submit();
        expect(alerts.at(-1)).toEqual(['Missing project or enterprise', 'Please pick the project or enterprise, or enter its public key.']);
        click(button('New hall roof'));
        await submit();
        expect(created).toEqual([expect.objectContaining({ effect: 'remove_lead_keeper', params: { enterprisePubkey: ROOF, leadPubkey: 'b'.repeat(64) } })]);
        click(button('Commons Pool'));
        click(radio("Pay off a project's or enterprise's debt"));
        type('e.g. Grant 200 beans to the Tool Library', 'Clear the stall debt');
        type('Explain why this decision is needed, what will be done, and who is responsible.', 'The stall closed');
        await submit();
        expect(alerts.at(-1)?.[0]).toBe('Missing project or enterprise');
        for (const [title, body] of alerts) {
            expect(`${title} ${body}`).not.toMatch(/Missing Enterprise|Lead Keeper|enterprise public key/);
        }
    });
});
