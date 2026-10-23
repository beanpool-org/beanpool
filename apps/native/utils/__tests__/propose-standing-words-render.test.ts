// @vitest-environment jsdom
/**
 * Who may propose a community Decision, as the phone says it, rendered for real: the Decide tab's Propose banner
 * (components/DecideSection.tsx), the propose form's no-bond notice (components/ProposeDecisionModal.tsx) and the Commons
 * explainer's voting steps (components/CommonsInfoModal.tsx). react-dom in jsdom, React Native's host components as plain
 * tags, @beanpool/core's words.
 *
 * Badges unlock nothing (Marty, 23 Oct): the node lets a member propose with a completed trade, or a node admin. A trust
 * badge ("earned standing", members.earned_credit) is no way in, so no screen may offer it as a second route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), TouchableWithoutFeedback: ({ children }: { children?: unknown }) => children as any,
        KeyboardAvoidingView: el('div'), Image: el('img'),
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        Alert: { alert: vi.fn() },
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-router', () => ({ router: { push: vi.fn(), navigate: vi.fn() } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});
vi.mock('../../components/CurrencyDisplay', () => ({ CurrencyDisplay: () => createElement('span', null, '🫘') }));
vi.mock('../db', () => ({ createDecision: vi.fn(async () => ({ success: true })) }));

import { DecideSection } from '../../components/DecideSection';
import { ProposeDecisionModal } from '../../components/ProposeDecisionModal';
import { CommonsInfoModal } from '../../components/CommonsInfoModal';

const ME = 'a'.repeat(64);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = async (node: unknown) => { await act(async () => { root.render(node as any); }); await act(async () => {}); };
const text = () => host.textContent ?? '';
// No second route: neither the old words nor a badge.
const offersNoBadgeRoute = () => expect(text()).not.toMatch(/earned standing|badge/i);

describe('who may propose a Decision, in the phone\'s words: a completed trade or a node admin, never a badge', () => {
    it('the Decide tab\'s Propose banner', async () => {
        await render(createElement(DecideSection, {
            decisions: [],
            myPoolVoting: null,
            identity: { publicKey: ME },
            balanceState: { earnedCredit: 0, commons: 0 },
            activeView: 'open',
            onChangeView: () => {},
            onRefresh: async () => {},
            onOpenPropose: () => {},
            canPropose: false,
            hasOpenDecision: false,
        }));
        expect(text()).toContain('Binding decisions execute automatically upon passing (§3.7). Open to members who have completed a trade, and to node admins.');
        expect(text()).toContain('⚠️ You can propose once you have completed a trade.');
        offersNoBadgeRoute();
    });

    it('the propose form\'s no-bond notice', async () => {
        await render(createElement(ProposeDecisionModal, {
            isOpen: true, onClose: () => {}, onCreated: () => {},
            identity: { publicKey: ME, callsign: 'Me' }, commonsBalance: 100, treasuries: [], members: [],
        }));
        expect(text()).toContain('No bond required. Open to members who have completed a trade, and to node admins. Open for 7 days. Closes and executes automatically.');
        offersNoBadgeRoute();
    });

    it('the Commons explainer\'s voting steps', async () => {
        await render(createElement(CommonsInfoModal, { isOpen: true, onClose: () => {}, commonsBalance: 0, initialTab: 'qv' }));
        expect(text()).toContain('1. Members who have completed a trade, and node admins, can open a binding Decision');
        offersNoBadgeRoute();
    });
});
