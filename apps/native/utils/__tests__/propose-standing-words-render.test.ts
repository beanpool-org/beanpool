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

describe('removal card Commons pool debt line', () => {
    const removalDecision = {
        id: 'rem-1',
        authorPubkey: 'a'.repeat(64),
        title: 'Remove someone',
        description: 'Testing removal',
        touches: 'member',
        effect: 'remove_member',
        franchise: '1m1v',
        status: 'open',
        subject: 'b'.repeat(64),
        closesAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        tally: { totalVoters: 5, quorumRequired: 10, supportRatio: 0.8, thresholdRequired: 0.66, yesWeight: 4, noWeight: 1 },
        params: { memberName: 'BadActor', commonsPool: 50 },
    } as any;

    it('Beans off: removal card does not show Commons pool debt line or warning box', async () => {
        await render(createElement(DecideSection, {
            decisions: [removalDecision],
            myPoolVoting: null,
            identity: { publicKey: ME },
            balanceState: { earnedCredit: 0, commons: 0 },
            activeView: 'open',
            onChangeView: () => {},
            onRefresh: async () => {},
            onOpenPropose: () => {},
            canPropose: true,
            hasOpenDecision: false,
            features: { beans: false, decisions: true },
        }));
        expect(host.querySelector('[data-testid="removal-debt-write-off-box"]')).toBeFalsy();
        expect(text()).not.toMatch(/Commons pool/i);
    });

    it('Beans on: removal card shows Commons pool debt line', async () => {
        await render(createElement(DecideSection, {
            decisions: [removalDecision],
            myPoolVoting: null,
            identity: { publicKey: ME },
            balanceState: { earnedCredit: 0, commons: 50 },
            activeView: 'open',
            onChangeView: () => {},
            onRefresh: async () => {},
            onOpenPropose: () => {},
            canPropose: true,
            hasOpenDecision: false,
            features: { beans: true, decisions: true },
        }));
        expect(host.querySelector('[data-testid="removal-debt-write-off-box"]')).toBeTruthy();
        expect(text()).toMatch(/Commons pool/i);
    });
});

describe('Beans off: nothing asks for a trade nobody can make; admins, and members who traded before Beans went off, propose (#2434 review r4366787637, #2434 Sonnet note)', () => {
    const decide = (canPropose: boolean, beans: boolean) => createElement(DecideSection, {
        decisions: [],
        myPoolVoting: null,
        identity: { publicKey: ME },
        balanceState: { earnedCredit: 0, commons: 0 },
        activeView: 'open',
        onChangeView: () => {},
        onRefresh: async () => {},
        onOpenPropose: () => {},
        canPropose,
        hasOpenDecision: false,
        features: { beans, decisions: true },
    });
    const alert = async () => vi.mocked((await import('react-native')).Alert.alert);

    it('a member who can\'t propose reads why, and is never asked to complete a trade', async () => {
        await render(decide(false, false));
        expect(text()).toContain('Binding decisions execute automatically upon passing (§3.7). Open to node admins, and to members who completed a trade before Beans were switched off.');
        expect(text()).toContain('⚠️ With Beans switched off, you can\'t complete a trade here, so you can\'t propose. Node admins can.');
        expect(text()).not.toMatch(/completed a trade\.|Complete a Trade First|once you have completed/i);
    });

    it('their Propose button says the same, never "Complete a Trade First"', async () => {
        const a = await alert();
        a.mockClear();
        await render(decide(false, false));
        act(() => { (host.querySelector('[aria-label="Propose a Community Decision"]') as HTMLElement).click(); });
        expect(a).toHaveBeenCalledWith('No Trades Here', 'With Beans switched off, nobody can complete a trade here, so you can\'t propose a Decision. Node admins can.');
    });

    it('someone who can propose is never asked to complete a trade either', async () => {
        await render(decide(true, false));
        expect(text()).not.toMatch(/Complete a Trade First|once you have completed a trade|You can propose once/i);
    });

    it('the propose form\'s notice (only someone who may propose opens it) names no gate and no trade', async () => {
        await render(createElement(ProposeDecisionModal, {
            isOpen: true, onClose: () => {}, onCreated: () => {},
            identity: { publicKey: ME, callsign: 'Me' }, commonsBalance: 0, treasuries: [], members: [],
            features: { beans: false, decisions: true },
        }));
        expect(text()).toContain('No bond required. Open for 7 days. Closes and executes automatically.');
        expect(text()).not.toMatch(/Complete a Trade First|once you have completed a trade|You can propose once/i);
    });

    it('the shared refusal: Beans off → no trade can be made here; Beans on → a completed trade, as before', async () => {
        const { proposeRefusal } = await import('../../components/DecideSection');
        const a = await alert();
        a.mockClear();
        expect(proposeRefusal(false, false, false)).toBe(true);
        expect(a).toHaveBeenLastCalledWith('No Trades Here', 'With Beans switched off, nobody can complete a trade here, so you can\'t propose a Decision. Node admins can.');
        expect(proposeRefusal(false, false, true)).toBe(true);
        expect(a).toHaveBeenLastCalledWith('Complete a Trade First', 'You can propose a Decision once you have completed a trade.');
        expect(proposeRefusal(true, true, false)).toBe(true);
        expect(a).toHaveBeenLastCalledWith('Limit Reached', 'You already have an open decision (limit 1 open decision per author).');
        expect(proposeRefusal(true, false, false)).toBe(false);
    });
});
