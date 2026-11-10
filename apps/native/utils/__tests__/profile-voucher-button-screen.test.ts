// @vitest-environment jsdom
/**
 * The owner's or admin's button on another member's profile (invites-vouching I4, fix round 1 of #3035), the whole screen
 * (app/public-profile.tsx) rendered with the recipe of public-profile-vouch.test.ts:
 *
 *  - It follows the person's state. The profile stays mounted under the names list and the voucher's card, so when it is in
 *    front again the node is asked again: Add to the names list does not stay after the person was added (a second tap would
 *    seal a duplicate entry the node refuses to confirm), Make a voucher does not stay after the voucher was made.
 *  - Where Beans are off the button is not drawn at all (a voucher is a Beans budget), as the web draws none there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) {
            attrs.onClick = (e: { stopPropagation?: () => void }) => {
                e?.stopPropagation?.();
                onPress();
            };
        }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(accessibilityState.selected);
        if (testID) attrs['data-testid'] = testID;
        if (disabled || accessibilityState?.disabled) attrs.disabled = true;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), SafeAreaView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        KeyboardAvoidingView: el('div'), Alert: alerts,
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', null, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
    };
});

const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
// The screen stays mounted under the screens its button opens; `focus.latest()` is that screen coming back to the front.
const focus = vi.hoisted(() => ({ latest: null as null | (() => void | (() => void)) }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: nav.router, useLocalSearchParams: () => nav.params, ErrorBoundary: () => null,
        useFocusEffect: (cb: () => void | (() => void)) => { focus.latest = cb; useEffect(() => cb(), [cb]); },
    };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-image', () => ({ Image: () => null }));

const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));

const VIEWER_KEY = 'a'.repeat(64);
const TARGET_KEY = 'b'.repeat(64);
const IDENTITY = { publicKey: VIEWER_KEY, privateKey: 'c'.repeat(64), callsign: 'Viewer' };

vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: IDENTITY, setIdentity: vi.fn() }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (f: (t: unknown) => unknown) => f(ctx) };
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));

/** What the node answers in the trust profile: the owner's or admin's button (absent for a plain member), and its Beans switch. */
const trustNow = vi.hoisted(() => ({ button: undefined as unknown, beans: true }));
const communityRow = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock('../db', () => ({
    getMemberProfile: vi.fn(async () => (communityRow.value ? { ...communityRow.value } : null)),
    getMemberRatings: vi.fn(async () => ({ average: 5, count: 1, asProvider: { average: 5 }, asReceiver: { average: 5 }, ratings: [] })),
    getMemberPosts: vi.fn(async () => []),
    getBalance: vi.fn(async () => ({ balance: 100 })),
    getRatingsGiven: vi.fn(async () => []),
    getFriendsLocal: vi.fn(async () => []),
    isFriendLocal: vi.fn(async () => false),
    addFriendLocal: vi.fn(async () => {}),
    removeFriendLocal: vi.fn(async () => {}),
    createConversationApi: vi.fn(async () => ({})),
    getTrustProfile: vi.fn(async () => ({
        tier: { name: 'Member', emoji: '🌱' },
        risk: { band: 'green', headline: 'Good standing' },
        stats: { tradeCount: 0, uniquePartners: 0 },
        completionRate: 1,
        mutualCount: 0,
        mutualConnections: [],
        vouchedInBy: null,
        ...(trustNow.button ? { voucherButton: trustNow.button } : {}),
    })),
    updateMemberProfile: vi.fn(async () => {}),
    pushWaitingArchetype: vi.fn(async () => true),
}));
vi.mock('../blocklist', () => ({
    BLOCKLIST_UPDATED_EVENT: 'beanpool_blocklist_updated',
    blockUser: vi.fn(async () => true), unblockUser: vi.fn(async () => true), isUserBlocked: vi.fn(async () => false),
}));
vi.mock('../channels', () => ({ fetchPublicChannels: vi.fn(async () => []) }));
vi.mock('../crypto', () => ({ buildSignedHeaders: vi.fn(async () => ({})) }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', checkedAt: new Date().toISOString(), features: { beans: trustNow.beans } }) }));
vi.mock('../use-reader-features', () => ({ useShowcaseMode: () => 'off' }));
vi.mock('../reads-own', () => ({ readsOwn: vi.fn(async () => true) }));
vi.mock('../members-lookup', () => ({ cardNeedsFetch: () => false, fetchCardByKey: vi.fn(async () => null) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({ LocalCommunityMark: () => null }));
vi.mock('../../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));

const node = vi.hoisted(() => ({
    voucher: true,
    budgetLeft: 550,
    budgetLevel: 1000,
    history: [] as any[],
    posts: [] as Array<{ path: string; body: any }>,
    postResult: null as any,
}));

vi.mock('../node-post', () => ({
    signedGet: vi.fn(async (_anchor: string, path: string) => {
        if (path === '/api/vouchers/me') {
            return {
                ok: true,
                json: async () => ({
                    voucher: node.voucher,
                    budget: { left: node.budgetLeft, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: node.budgetLevel },
                    presets: [25, 50, 75, 100],
                    vouchMax: 100,
                    budgetMax: 2000,
                    vouchedBy: [],
                    history: node.history,
                }),
            };
        }
        return { ok: false, json: async () => null };
    }),
    signedPost: vi.fn(async (_anchor: string, path: string, body: any) => {
        node.posts.push({ path, body });
        if (node.postResult) {
            return node.postResult;
        }
        return {
            ok: true,
            json: async () => ({
                id: 'gift-1',
                memberPubkey: body.memberPubkey,
                amount: body.vouchAmount,
                total: body.vouchAmount,
                budget: { left: node.budgetLeft - body.vouchAmount },
            }),
        };
    }),
}));

import PublicProfileScreen from '../../app/public-profile';
import { getTrustProfile } from '../db';

const NODE = 'https://node.example.test';

let host: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
    mem.store.clear();
    mem.store.set('beanpool_anchor_url', NODE);
    nav.params = { publicKey: TARGET_KEY, callsign: 'sam' };
    communityRow.value = { public_key: TARGET_KEY, callsign: 'sam', avatar_url: null, bio: null, archetype: null };
    node.voucher = true;
    node.budgetLeft = 550;
    node.budgetLevel = 1000;
    node.history = [];
    node.posts = [];
    node.postResult = null;
    alerts.alert.mockClear();
    trustNow.button = undefined;
    trustNow.beans = true;
    focus.latest = null;
    nav.router.push.mockClear();
    vi.mocked(getTrustProfile).mockClear();
});

afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    host = null;
    root = null;
});

async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(PublicProfileScreen as any) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}


const button = () => host?.querySelector('[data-testid="profile-voucher-button"]') as HTMLButtonElement | null;
const comeBack = async () => { await act(async () => { focus.latest!(); }); await settle(); };

describe('the profile’s names-list / voucher button follows the person’s state', () => {
    it('draws what the node says, and the first focus is not a second read', async () => {
        trustNow.button = { state: 'add' };
        await render();
        expect(button()?.textContent).toBe('Add to the names list');
        expect(vi.mocked(getTrustProfile)).toHaveBeenCalledTimes(1);
    });

    it('back from the names list after the person was added: the node says Make, and the button says Make', async () => {
        trustNow.button = { state: 'add' };
        await render();
        trustNow.button = { state: 'make' };
        await comeBack();
        expect(button()?.textContent).toBe('Make a voucher');
        await act(async () => { button()!.click(); });
        expect(nav.router.push).toHaveBeenCalledWith({ pathname: '/names-list', params: { act: 'make', forMember: TARGET_KEY, forCallsign: 'sam' } });
    });

    it('back after the voucher was made: Voucher · 400 left ›', async () => {
        trustNow.button = { state: 'make' };
        await render();
        trustNow.button = { state: 'voucher', left: 400, noLimit: false };
        await comeBack();
        expect(button()?.textContent).toBe('Voucher · 400 left ›');
    });

    it('back when the node now offers nothing (a confirmation waiting for its second admin): the button goes', async () => {
        trustNow.button = { state: 'add' };
        await render();
        trustNow.button = undefined;
        await comeBack();
        expect(button()).toBeNull();
    });

    it('a profile that showed no button asks nothing more when it comes back (a plain member reads nothing extra)', async () => {
        await render();
        expect(button()).toBeNull();
        await comeBack();
        expect(vi.mocked(getTrustProfile)).toHaveBeenCalledTimes(1);
    });

    it('an unchanged answer changes nothing on screen', async () => {
        trustNow.button = { state: 'add' };
        await render();
        await comeBack();
        await comeBack();
        expect(button()?.textContent).toBe('Add to the names list');
    });

    it('Beans off: no button, even if one were sent', async () => {
        trustNow.beans = false;
        trustNow.button = { state: 'add' };
        await render();
        expect(button()).toBeNull();
    });
});
