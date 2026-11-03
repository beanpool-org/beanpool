// @vitest-environment jsdom
/**
 * Vouch for them on the phone, the whole of app/(tabs)/people.tsx rendered for real (the mount of
 * showcase-people-render.test.ts): who sees the control, what goes to the node, and that a level never turns into an offline
 * ticket, which would carry none while the voucher believed it had. Its fetch is a fake node: nothing leaves the test.
 * askCanVouch, which answers who can vouch, is driven through the real utils/db.ts in invite-vouch-right.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as Array<[string, string | undefined]> }));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'radio') attrs.role = 'radio';
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
            ListHeaderComponent,
            (data ?? []).length
                ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
                : ListEmptyComponent,
            ListFooterComponent),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert: (title: string, text?: string) => { alerts.said.push([title, text]); } },
        Share: { share: async () => ({}) },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {}, replace() {} },
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => ({ view: 'invites' }),
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    // The ask sheet's lift (components/InviteAsks.tsx, useModalKeyboardLift): no keyboard here.
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'a-voucher-key', callsign: 'Robin', privateKey: 'aa' } }) }));

const who = vi.hoisted(() => ({ canVouch: true, asked: 0 }));
const tickets = vi.hoisted(() => ({ made: 0 }));
const never = () => new Promise<never>(() => {});
vi.mock('../db', () => ({
    askCanVouch: async () => { who.asked++; return who.canVouch; },
    getDb: () => new Promise<never>(() => {}), getFriendsLocal: async () => [], addFriendLocal: () => new Promise<never>(() => {}),
    removeFriendLocal: () => new Promise<never>(() => {}), createConversationApi: () => new Promise<never>(() => {}),
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../member-statements', () => ({ makeOfflineTicket: async () => { tickets.made++; return 'BP-TICKET'; } }));
vi.mock('../membership-probe', () => ({ fetchMembership: () => new Promise<never>(() => {}) }));
vi.mock('../node-admin', () => ({
    askNodeRole: () => new Promise<never>(() => {}), persistNodeRole: async () => {}, readPersistedNodeRole: async () => undefined, rememberNodeRole: async () => {},
}));
vi.mock('../knock-inbox', () => ({ fetchJoinRequests: () => new Promise<never>(() => {}) }));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: () => new Promise<never>(() => {}), joinedNudge: () => '', PROTECT_REDIRECT: '', HOME_REDIRECT: '' }));
vi.mock('../community-switch', () => ({ communitySwitched: () => () => {} }));
vi.mock('../global-join-existing', () => ({ isGlobalCommunity: () => false }));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'checking' }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise<never>(() => {}), signedPost: () => new Promise<never>(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../../components/WantsToJoin', () => ({ WantsToJoin: () => null }));
vi.mock('../../components/MyJoinRequests', () => ({ MyJoinRequests: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));

import PeopleScreen from '../../app/(tabs)/people';
import { INVITE_VOUCH_WORDS, t } from '@beanpool/core';

const NODE = 'https://node.example';
const LOCAL = { beans: true, invites: true, inviteVouch: true, showcase: false };
const rememberProfile = (features: Record<string, boolean>) =>
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features, checkedAt: new Date().toISOString() } }));

/** The fake node: the last bodies it took, and how it answers the next invite. */
const node = { made: [] as Array<Record<string, unknown>>, down: false, refusal: null as null | { status: number; body: unknown } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    rememberProfile(LOCAL);
    who.canVouch = true;
    who.asked = 0;
    tickets.made = 0;
    alerts.said.length = 0;
    node.made = [];
    node.down = false;
    node.refusal = null;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/api/invite/generate')) {
            if (node.down) throw new TypeError('Network request failed');
            node.made.push(JSON.parse(String(init?.body)));
            if (node.refusal) return json(node.refusal.body, node.refusal.status);
            return json({ success: true, invite: { code: 'INV-TEST-0001' } });
        }
        if (u.endsWith('/api/community/health')) return json({ ok: true });
        if (u.includes('/api/invite/mine/')) return json({ invites: [] });
        return never();
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const open = async () => { await act(async () => { root.render(createElement(PeopleScreen) as any); }); await settle(); };
const radios = () => Array.from(host.querySelectorAll('[role="radio"]')).map((r) => `${r.getAttribute('aria-label')}:${r.getAttribute('aria-checked')}`);
const pick = async (level: number) => { await act(async () => { (host.querySelector(`[data-testid="invite-vouch-${level}"]`) as HTMLElement).click(); }); await settle(); };
const generate = async () => {
    const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Generate'));
    expect(button, 'the Generate button').toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
};

describe('who sees Vouch for them', () => {
    it('someone who can vouch: four named choices, None on', async () => {
        await open();
        expect(who.asked).toBe(1);
        expect(radios()).toEqual(['None:true', '25 Beans:false', '50 Beans:false', '100 Beans:false']);
    });

    it('a member who can\'t vouch: no control', async () => {
        who.canVouch = false;
        await open();
        expect(radios()).toEqual([]);
        expect(host.querySelector('[data-testid="invite-vouch"]')).toBeNull();
    });

    it('a node that doesn\'t say an invite can carry one (Beans off, or older): no control, and nothing asked', async () => {
        rememberProfile({ beans: true, invites: true, showcase: false });
        await open();
        expect(radios()).toEqual([]);
        expect(who.asked).toBe(0);
    });

    it('a phone that can\'t reach the node: no control, so the button is the offline ticket as ever', async () => {
        (globalThis.fetch as any).mockImplementation(async () => { throw new TypeError('Network request failed'); });
        await open();
        expect(radios()).toEqual([]);
        expect(host.textContent).toContain('Generate Offline Ticket');
    });
});

describe('what goes to the node', () => {
    it('None sends no level at all: the body as it always was', async () => {
        await open();
        await generate();
        expect(node.made).toHaveLength(1);
        expect(Object.keys(node.made[0]).sort()).toEqual(['publicKey']);
    });

    it('sends the level picked, then goes back to None so a second invite carries nothing by accident', async () => {
        await open();
        await pick(2);
        expect(radios()).toEqual(['None:false', '25 Beans:false', '50 Beans:true', '100 Beans:false']);
        await generate();
        expect(node.made[0]).toMatchObject({ publicKey: 'a-voucher-key', vouchLevel: 2 });
        expect(radios()[0]).toBe('None:true');
        await generate();
        expect(node.made[1]).not.toHaveProperty('vouchLevel');
    });
});

describe('a level never turns into a ticket', () => {
    it('the node refuses: its words, no ticket, and the choice stays for the member to change', async () => {
        node.refusal = { status: 403, body: { error: INVITE_VOUCH_WORDS.notAVoucher, code: 'not_a_voucher' } };
        await open();
        await pick(3);
        await generate();
        expect(alerts.said).toEqual([[t('Could not vouch'), t(INVITE_VOUCH_WORDS.notAVoucher)]]);
        expect(tickets.made).toBe(0);
        expect(radios()[3]).toBe('100 Beans:true');
    });

    it('the connection goes after a level was picked: it says so, and makes no ticket', async () => {
        await open();
        await pick(1);
        node.down = true;
        await generate();
        expect(alerts.said).toEqual([[t('Could not vouch'), t(INVITE_VOUCH_WORDS.noOfflineVouch)]]);
        expect(tickets.made).toBe(0);
    });

    it('on None, a dropped connection still makes the ticket, as it always did', async () => {
        await open();
        node.down = true;
        await generate();
        expect(tickets.made).toBe(1);
        expect(alerts.said.map(([title]) => title)).toEqual([t('Offline Mode')]);
    });
});
