// @vitest-environment jsdom
/**
 * Profile S2-W: the public-profile quiz publishes this community's name, not the phone-wide identity.callsign.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, accessibilityState, disabled, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), SafeAreaView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        KeyboardAvoidingView: el('div'), Alert: { alert: vi.fn() },
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', null, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        DeviceEventEmitter: {
            addListener: vi.fn(() => ({ remove: vi.fn() })),
            emit: vi.fn(),
        },
    };
});

const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('expo-router', () => ({
    router: nav.router,
    useLocalSearchParams: () => nav.params,
    ErrorBoundary: () => null,
    useFocusEffect: (cb: () => void) => { cb(); },
}));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));

const KEY = 'a'.repeat(64);
const IDENTITY = { publicKey: KEY, privateKey: 'b'.repeat(64), callsign: 'Rosa Phone' };
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
const calls = vi.hoisted(() => ({ updateMemberProfile: [] as Array<{ pubkey: string; data: Record<string, unknown> }> }));

vi.mock('../db', () => ({
    // A row read fresh each time, as the copy gives it: what one reader changes on its row is no other reader's.
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
    getTrustProfile: vi.fn(async () => null),
    vouchMember: vi.fn(async () => {}),
    updateMemberProfile: vi.fn(async (pubkey: string, data: Record<string, unknown>) => { calls.updateMemberProfile.push({ pubkey, data }); }),
}));

vi.mock('../blocklist', () => ({
    BLOCKLIST_UPDATED_EVENT: 'beanpool_blocklist_updated',
    blockUser: vi.fn(async () => true),
    unblockUser: vi.fn(async () => true),
    isUserBlocked: vi.fn(async () => false),
}));

vi.mock('../channels', () => ({ fetchPublicChannels: vi.fn(async () => []) }));
vi.mock('../crypto', () => ({ buildSignedHeaders: vi.fn(async () => ({ 'Content-Type': 'application/json' })) }));
vi.mock('../use-node-profile', () => ({
    useNodeProfile: () => ({ profile: 'local', checkedAt: new Date().toISOString(), features: { beans: true } }),
}));
vi.mock('../use-reader-features', () => ({ useShowcaseMode: () => 'off' }));
vi.mock('../reads-own', () => ({ readsOwn: vi.fn(async () => true) }));
vi.mock('../members-lookup', () => ({ cardNeedsFetch: () => false, fetchCardByKey: vi.fn(async () => null) }));
const device = vi.hoisted(() => ({ value: null as null | { archetype?: string }, saved: [] as Array<{ archetype?: string | null }> }));
vi.mock('../canonical-profile', () => ({
    getCanonicalProfile: vi.fn(async () => device.value),
    saveCanonicalProfile: vi.fn(async (partial: { archetype?: string | null }) => { device.saved.push(partial); }),
}));

vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({ LocalCommunityMark: () => null }));

vi.mock('../../components/ArchetypeQuizModal', () => ({
    ArchetypeQuizModal: ({ visible, onComplete }: { visible: boolean; onComplete: (res: any) => void }) => {
        return visible ? createElement('button', {
            'data-testid': 'complete-quiz',
            onClick: () => onComplete({
                primary: 'catalyst',
                secondary: 'weaver',
                mode: 'quick',
                updatedAt: '2026-10-31T00:00:00.000Z',
            }),
        }, 'Complete Quiz') : null;
    },
}));

import { ARCHETYPES } from '@beanpool/core';
import PublicProfileScreen from '../../app/public-profile';

const NODE = 'https://second.example.test';

let host: HTMLElement | null = null;
let root: Root | null = null;
let requests: Array<{ url: string; method: string; body: string | undefined }> = [];

beforeEach(() => {
    mem.store.clear();
    mem.store.set('beanpool_anchor_url', NODE);
    nav.params = { publicKey: KEY };
    nav.router.replace.mockClear();
    calls.updateMemberProfile = [];
    communityRow.value = null;
    device.value = null;
    device.saved = [];
    requests = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url, method: init?.method ?? 'GET', body: init?.body });
        return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
});

afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    host = null;
    root = null;
});

async function settle(rounds = 6) {
    for (let i = 0; i < rounds; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

async function render() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(PublicProfileScreen as any) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}

const published = () => requests.filter(r => r.url === `${NODE}/api/profile/update`).map(r => JSON.parse(r.body ?? '{}'));

describe('public-profile quiz publishes this community name (Profile S2-W)', () => {
    it('publishes this community row callsign ("Rosa Community"), not the phone-wide name ("Rosa Phone")', async () => {
        communityRow.value = { public_key: KEY, callsign: 'Rosa Community', avatar_url: null, bio: null };
        await render();

        // Tap Take Quiz button
        const quizBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Take 60s Quiz'));
        expect(quizBtn).toBeDefined();
        await act(async () => { quizBtn!.click(); });
        await settle();

        // Tap Complete Quiz inside mock modal
        const completeBtn = document.querySelector('[data-testid="complete-quiz"]') as HTMLElement;
        expect(completeBtn).not.toBeNull();
        await act(async () => { completeBtn.click(); });
        await settle();

        // The publish must carry "Rosa Community", NOT "Rosa Phone"
        expect(published()).toHaveLength(1);
        expect(published()[0].callsign).toBe('Rosa Community');
        expect(calls.updateMemberProfile).toHaveLength(1);
        expect(calls.updateMemberProfile[0].data.callsign).toBe('Rosa Community');
    });

    it('falls back to identity.callsign only when this community holds no row for the member yet', async () => {
        communityRow.value = null;
        await render();

        const quizBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Take 60s Quiz'));
        expect(quizBtn).toBeDefined();
        await act(async () => { quizBtn!.click(); });
        await settle();

        const completeBtn = document.querySelector('[data-testid="complete-quiz"]') as HTMLElement;
        expect(completeBtn).not.toBeNull();
        await act(async () => { completeBtn.click(); });
        await settle();

        expect(published()).toHaveLength(1);
        expect(published()[0].callsign).toBe('Rosa Phone');
        expect(calls.updateMemberProfile).toHaveLength(1);
        expect(calls.updateMemberProfile[0].data.callsign).toBe('Rosa Phone');
    });

    it('does not send callsign when callsign is empty, and never touches bio/contact on quiz complete', async () => {
        const origCallsign = IDENTITY.callsign;
        IDENTITY.callsign = '';
        try {
            communityRow.value = null;
            await render();

            const quizBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Take 60s Quiz'));
            expect(quizBtn).toBeDefined();
            await act(async () => { quizBtn!.click(); });
            await settle();

            const completeBtn = document.querySelector('[data-testid="complete-quiz"]') as HTMLElement;
            expect(completeBtn).not.toBeNull();
            await act(async () => { completeBtn.click(); });
            await settle();

            expect(published()).toHaveLength(1);
            expect(published()[0]).not.toHaveProperty('callsign');
            expect(calls.updateMemberProfile).toHaveLength(1);
            expect(calls.updateMemberProfile[0].data).not.toHaveProperty('bio');
            expect(calls.updateMemberProfile[0].data).not.toHaveProperty('contact_value');
            expect(calls.updateMemberProfile[0].data).not.toHaveProperty('avatar_url');
        } finally {
            IDENTITY.callsign = origCallsign;
        }
    });
});

describe('the quiz is one result, for every community on the phone (working style S1)', () => {
    const OTHER = 'https://first.example.test';
    const STRANGER = 'https://looked-at.example.test';
    const takeQuiz = async () => {
        const quizBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Take 60s Quiz'));
        expect(quizBtn).toBeDefined();
        await act(async () => { quizBtn!.click(); });
        await settle();
        await act(async () => { (document.querySelector('[data-testid="complete-quiz"]') as HTMLElement).click(); });
        await settle();
    };
    const waitingAt = (url: string) => {
        const raw = mem.store.get(`beanpool_pending_profile:archetype:${new URL(url).origin}`);
        return raw ? JSON.parse(raw).archetype : null;
    };
    const SENT = JSON.stringify({ primary: 'catalyst', secondary: 'weaver', mode: 'quick', takenOn: '2026-10-31' });

    it('publishes the type, the wing, the mode and the day, and no clock', async () => {
        communityRow.value = { public_key: KEY, callsign: 'Rosa', avatar_url: null, bio: null };
        await render();
        await takeQuiz();
        expect(published()[0].archetype).toBe(SENT);
    });

    it('the result becomes the device\'s, and waits for every other community saved on the phone', async () => {
        mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: NODE }, { url: OTHER }]));
        communityRow.value = { public_key: KEY, callsign: 'Rosa', avatar_url: null, bio: null };
        await render();
        await takeQuiz();
        expect(JSON.parse(device.saved[0].archetype!).primary).toBe('catalyst');
        expect(waitingAt(OTHER)).toBe(SENT);
        expect(waitingAt(NODE)).toBeNull();
        expect(requests.filter(r => r.url.startsWith(OTHER))).toEqual([]);
    });

    it('a guest visit elsewhere on the phone is not marked', async () => {
        mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: NODE }, { url: STRANGER }]));
        const { markGuestNode } = await import('../nodes');
        await markGuestNode(STRANGER);
        communityRow.value = { public_key: KEY, callsign: 'Rosa', avatar_url: null, bio: null };
        await render();
        await takeQuiz();
        expect(waitingAt(STRANGER)).toBeNull();
    });

    it('open on a guest visit, the phone keeps the result and that community is sent nothing', async () => {
        const { markGuestNode } = await import('../nodes');
        await markGuestNode(NODE);
        await render();
        await takeQuiz();
        expect(JSON.parse(device.saved[0].archetype!).primary).toBe('catalyst');
        expect(published()).toEqual([]);
    });

    it('a publish the community refused, or that never reached it, waits for its next sync', async () => {
        communityRow.value = { public_key: KEY, callsign: 'Rosa', avatar_url: null, bio: null };
        (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
        await render();
        await takeQuiz();
        expect(waitingAt(NODE)).toBe(SENT);

        mem.store.delete(`beanpool_pending_profile:archetype:${new URL(NODE).origin}`);
        (globalThis as any).fetch = vi.fn(async () => { throw new TypeError('Network request failed'); });
        if (root) act(() => root!.unmount());
        host?.remove();
        await render();
        await takeQuiz();
        expect(waitingAt(NODE)).toBe(SENT);
    });

    it('a phone that can\'t write what waits still publishes', async () => {
        communityRow.value = { public_key: KEY, callsign: 'Rosa', avatar_url: null, bio: null };
        await render();
        const { default: storage } = await import('@react-native-async-storage/async-storage');
        const setItem = vi.mocked(storage.setItem);
        const writes = setItem.getMockImplementation()!;
        setItem.mockImplementation(async (key, value) => {
            if (key.startsWith('beanpool_pending_profile:archetype:')) throw new Error('disk full');
            return writes(key, value);
        });
        try {
            await takeQuiz();
        } finally {
            setItem.mockImplementation(writes);
        }
        expect(published()).toHaveLength(1);
        expect(published()[0].archetype).toBe(SENT);
    });

    it('a publish that landed leaves nothing waiting here', async () => {
        communityRow.value = { public_key: KEY, callsign: 'Rosa', avatar_url: null, bio: null };
        await render();
        await takeQuiz();
        expect(waitingAt(NODE)).toBeNull();
    });

    it('My Profile shows the device\'s newer result over this community\'s older row, and the row\'s when it is the newer', async () => {
        const row = JSON.stringify({ primary: 'guardian', secondary: 'weaver', mode: 'quick', takenOn: '2026-10-01' });
        const newer = JSON.stringify({ primary: 'spark', secondary: 'weaver', mode: 'quick', takenOn: '2026-11-02' });
        communityRow.value = { public_key: KEY, callsign: 'Rosa', avatar_url: null, bio: null, archetype: row };
        device.value = { archetype: newer };
        await render();
        expect(document.body.textContent).toContain(ARCHETYPES.spark.name);
        expect(document.body.textContent).not.toContain(ARCHETYPES.guardian.name);

        if (root) act(() => root!.unmount());
        host?.remove();
        communityRow.value = { public_key: KEY, callsign: 'Rosa', avatar_url: null, bio: null, archetype: newer };
        device.value = { archetype: row };
        await render();
        expect(document.body.textContent).toContain(ARCHETYPES.spark.name);
    });
});
