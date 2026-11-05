// @vitest-environment jsdom
/**
 * Remove my working style on My Profile (DESIGN-archetype-across-fable.md §3, S3): one button on the card, one confirm in
 * plain words, then the card goes back to the invitation and the community open is told at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
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
// The profile's listing cards draw through components/ListPhoto, which imports expo-image (a native module this test does not load).
vi.mock('expo-image', () => ({ Image: () => null }));

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
const pushed = vi.hoisted(() => ({ calls: [] as Array<{ community: string }> }));
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
    getTrustProfile: vi.fn(async () => null),
    updateMemberProfile: vi.fn(async () => {}),
    pushWaitingArchetype: vi.fn(async (opts: { community: string }) => { pushed.calls.push(opts); return true; }),
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
const device = vi.hoisted(() => ({ value: null as null | { archetype?: string | null } }));
vi.mock('../canonical-profile', () => ({
    getCanonicalProfile: vi.fn(async () => device.value),
    saveCanonicalProfile: vi.fn(async () => {}),
}));
const removed = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../working-style', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../working-style')>()),
    removeWorkingStyle: vi.fn(async (key: string) => { removed.calls.push(key); }),
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({ LocalCommunityMark: () => null }));
vi.mock('../../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));

import { ARCHETYPES } from '@beanpool/core';
import PublicProfileScreen from '../../app/public-profile';

const NODE = 'https://second.example.test';
const RESULT = JSON.stringify({ primary: 'spark', secondary: 'weaver', mode: 'quick', takenOn: '2026-11-02' });
const SENTENCE = 'This takes your working style off this device and out of every community on it. A retake brings it back.';

let host: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
    mem.store.clear();
    mem.store.set('beanpool_anchor_url', NODE);
    nav.params = { publicKey: KEY };
    communityRow.value = { public_key: KEY, callsign: 'Rosa', avatar_url: null, bio: null, archetype: RESULT };
    device.value = null;
    removed.calls = [];
    pushed.calls = [];
    alerts.alert.mockClear();
    (globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
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
const removeButton = () => document.querySelector('button[aria-label="Remove my working style"]') as HTMLElement | null;

describe('Remove my working style on the phone\'s card', () => {
    it('is on the card of a member who has a result, and not on the invitation of one who has none', async () => {
        await render();
        expect(document.body.textContent).toContain(ARCHETYPES.spark.name);
        expect(removeButton()).not.toBeNull();
        expect(removeButton()!.textContent).toBe('Remove my working style');

        if (root) act(() => root!.unmount());
        host?.remove();
        communityRow.value = { public_key: KEY, callsign: 'Rosa', avatar_url: null, bio: null, archetype: null };
        await render();
        expect(document.body.textContent).toContain('Take 60s Quiz');
        expect(removeButton()).toBeNull();
    });

    it('asks once, in plain words, and a cancel removes nothing', async () => {
        await render();
        await act(async () => { removeButton()!.click(); });
        expect(alerts.alert).toHaveBeenCalledTimes(1);
        const [title, message, buttons] = alerts.alert.mock.calls[0];
        expect(title).toBe('Remove my working style');
        expect(message).toBe(SENTENCE);
        expect(buttons.map((b: { text: string }) => b.text)).toEqual(['Cancel', 'Remove']);
        expect(buttons[0].style).toBe('cancel');
        // No scolding, no second question: nothing was removed by asking.
        expect(removed.calls).toEqual([]);
        expect(document.body.textContent).toContain(ARCHETYPES.spark.name);
    });

    it('Remove takes the result off the phone, tells the open community at once, and the card goes back to the invitation', async () => {
        await render();
        await act(async () => { removeButton()!.click(); });
        const remove = alerts.alert.mock.calls[0][2].find((b: { text: string }) => b.text === 'Remove');
        expect(remove.style).toBe('destructive');
        await act(async () => { await remove.onPress(); });
        await settle();

        expect(removed.calls).toEqual([KEY]);
        expect(pushed.calls).toEqual([{ community: NODE }]);
        expect(document.body.textContent).not.toContain(ARCHETYPES.spark.name);
        expect(document.body.textContent).toContain('Take 60s Quiz');
        expect(removeButton()).toBeNull();
    });

    it('the button is 44 dp tall, in the card\'s own ink', () => {
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../app/public-profile.tsx'), 'utf8');
        const style = source.slice(source.indexOf('synergyRemoveBtn: {'), source.indexOf('synergyRetakeBtnText: {'));
        expect(style).toMatch(/minHeight: 44/);
        expect(style).toContain('colors.text.secondary');
        expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    });
});
