// @vitest-environment jsdom
/**
 * Public profile vouch screen tests (slice V3, §9):
 * - Renders "Vouch for @name" on a person's profile when viewer is a voucher
 * - Selecting a preset and submitting sends the vouch request to the node
 * - At 100 (the most a vouch can be), the card hides Raise vouch
 * - After an over_max refusal, the selection goes back to what was in effect before the press
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
vi.mock('expo-router', () => ({ router: nav.router, useLocalSearchParams: () => nav.params, ErrorBoundary: () => null, useFocusEffect: (cb: () => void) => { cb(); } }));
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
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', checkedAt: new Date().toISOString(), features: { beans: true } }) }));
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

describe('Native Public Profile Vouch (§9)', () => {
    it('renders "Vouch for @sam" on a person\'s profile when viewer is a voucher', async () => {
        await render();
        const vouchCard = host?.querySelector('[data-testid="profile-vouch"]');
        expect(vouchCard).not.toBeNull();
        expect(vouchCard?.textContent).toContain('Vouch for @sam');
        expect(host?.querySelector('[data-testid="profile-vouch-submit"]')).not.toBeNull();
    });

    it('does not render profile vouch when viewer is not a voucher', async () => {
        node.voucher = false;
        await render();
        expect(host?.querySelector('[data-testid="profile-vouch"]')).toBeNull();
    });

    it('presses a preset and checks the request body', async () => {
        await render();
        const b25 = host?.querySelector('[data-testid="invite-vouch-25"]') as HTMLButtonElement;
        expect(b25).not.toBeNull();
        await act(async () => { b25.click(); });
        await settle();

        const submit = host?.querySelector('[data-testid="profile-vouch-submit"]') as HTMLButtonElement;
        expect(submit).not.toBeNull();
        await act(async () => { submit.click(); });
        await settle();

        expect(node.posts).toHaveLength(1);
        expect(node.posts[0]).toEqual({
            path: '/api/vouch',
            body: {
                memberPubkey: TARGET_KEY,
                vouchAmount: 25,
                raise: false,
            },
        });
        expect(host?.querySelector('[data-testid="profile-vouch-success"]')?.textContent).toContain('Vouched 25 Beans for @sam.');
    });

    it('at 100 (the most a vouch can be) the person\'s card hides Raise vouch', async () => {
        node.history = [
            {
                kind: 'hold',
                amount: -100,
                actor: VIEWER_KEY,
                actorCallsign: 'Viewer',
                at: '2026-11-01T00:00:00.000Z',
                for: 'profile',
                person: { memberPubkey: TARGET_KEY, callsign: 'sam' },
            },
        ];
        await render();
        expect(host?.querySelector('[data-testid="profile-vouch"]')).toBeNull();
        expect(host?.textContent).not.toContain('Raise vouch for @sam');
        expect(host?.querySelector('[data-testid="profile-vouch-submit"]')).toBeNull();
    });

    it('after an over_max refusal the refused preset is no longer selected', async () => {
        node.postResult = {
            ok: false,
            json: async () => ({
                error: 'Your vouches for @sam can’t go past 100 Beans.',
                code: 'over_max',
                prior: 75,
            }),
        };

        await render();
        const b50 = host?.querySelector('[data-testid="invite-vouch-50"]') as HTMLButtonElement;
        expect(b50).not.toBeNull();
        await act(async () => { b50.click(); });
        await settle();

        const submit = host?.querySelector('[data-testid="profile-vouch-submit"]') as HTMLButtonElement;
        await act(async () => { submit.click(); });
        await settle();

        expect(host?.querySelector('[data-testid="profile-vouch-refusal"]')?.textContent).toContain(
            'Your vouches for @sam can’t go past 100 Beans.'
        );
        // Refused preset is no longer selected
        const b50After = host?.querySelector('[data-testid="invite-vouch-50"]') as HTMLButtonElement;
        expect(b50After?.getAttribute('aria-checked')).not.toBe('true');
        expect(submit.hasAttribute('disabled')).toBe(true);
    });
});
