// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
vi.mock('react-native', async () => (await import('./profile-events-words-harness')).nativeMock(alerts));

const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, pushed: [] as unknown[] }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => nav.pushed.push(to), replace: (to: unknown) => nav.pushed.push(to), back: () => {}, canGoBack: () => true },
    useLocalSearchParams: () => nav.params,
    useFocusEffect: () => {},
    ErrorBoundary: () => null,
}));

vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return { SafeAreaView: ({ children }: { children?: unknown }) => h('div', null, children as any), useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) };
});

vi.mock('@expo/vector-icons', async () => {
    const { createElement: h } = await import('react');
    return { MaterialCommunityIcons: ({ name }: { name: string }) => h('i', { 'data-icon': name }) };
});

vi.mock('expo-image', async () => {
    const { createElement: h } = await import('react');
    return { Image: (p: { accessibilityLabel?: string }) => h('img', p.accessibilityLabel ? { 'aria-label': p.accessibilityLabel } : {}) };
});

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));

const { OWN, KOFI, who } = vi.hoisted(() => {
    const OWN = '9'.repeat(64);
    const KOFI = '3'.repeat(64);
    const who = { value: { identity: { publicKey: OWN, privateKey: '8'.repeat(64), callsign: 'Wren' } } };
    return { OWN, KOFI, who };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who.value }));

vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});

const data = vi.hoisted(() => ({
    profiles: {} as Record<string, Record<string, unknown> | null>,
    friends: [] as Array<{ publicKey: string }>,
    addedFriends: [] as string[],
    blockedUsers: new Set<string>(),
    unblockedUsers: [] as string[],
    conversationsCreated: [] as any[],
    createConvError: null as Error | null,
}));

vi.mock('../db', () => ({
    getMemberProfile: vi.fn(async (k: string) => data.profiles[k] ?? null),
    getMemberRatings: vi.fn(async () => null),
    getMemberPosts: vi.fn(async () => []),
    getBalance: vi.fn(async () => null),
    getRatingsGiven: vi.fn(async () => []),
    getFriendsLocal: vi.fn(async () => data.friends),
    addFriendLocal: vi.fn(async (me: string, them: string) => {
        data.addedFriends.push(them);
        data.friends.push({ publicKey: them });
    }),
    removeFriendLocal: vi.fn(async (me: string, them: string) => {
        data.friends = data.friends.filter(f => f.publicKey !== them);
    }),
    createConversationApi: vi.fn(async (type: string, participants: string[], createdBy: string) => {
        if (data.createConvError) throw data.createConvError;
        data.conversationsCreated.push({ type, participants, createdBy });
        return { id: 'conv-dm-123', participants, type };
    }),
    getTrustProfile: vi.fn(async () => null),
    vouchMember: vi.fn(async () => undefined),
    updateMemberProfile: vi.fn(async () => undefined),
}));

vi.mock('../blocklist', () => ({
    blockUser: vi.fn(async (target: string) => { data.blockedUsers.add(target); }),
    unblockUser: vi.fn(async (target: string) => {
        data.blockedUsers.delete(target);
        data.unblockedUsers.push(target);
        return true;
    }),
    isUserBlocked: vi.fn(async (target: string) => data.blockedUsers.has(target)),
    getBlockedUsers: vi.fn(async () => Array.from(data.blockedUsers)),
}));

vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null) }));
vi.mock('../channels', () => ({ fetchPublicChannels: vi.fn(async () => []) }));
vi.mock('../crypto', () => ({ buildSignedHeaders: vi.fn(async () => ({})) }));
vi.mock('../use-node-profile', () => ({
    useNodeProfile: () => ({ profile: 'local', checkedAt: '2026-10-19T00:00:00.000Z', features: { beans: true } }),
}));
vi.mock('../use-reader-features', () => ({ useShowcaseMode: () => 'off' }));
vi.mock('../reads-own', () => ({ readsOwn: vi.fn(async () => true) }));
vi.mock('../members-lookup', () => ({ cardNeedsFetch: () => false, fetchCardByKey: vi.fn(async () => 'fresh') }));
vi.mock('../image-processing', () => ({ avatarUri: (url: string | null) => url }));
vi.mock('../node-post', () => ({ anchorUrl: async () => null, getCachedAnchorUrl: () => 'https://mullum.example' }));
vi.mock('../bundled-avatars', () => ({ resolveBundledAvatar: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', async () => {
    const { createElement: h } = await import('react');
    return { LocalCommunityMark: ({ text }: { text: string }) => h('span', null, text) };
});

import { LanguageProvider } from '../../components/LanguageProvider';
import PublicProfileScreen from '../../app/public-profile';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons = [];
    nav.params = {};
    nav.pushed.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://mullum.example');
    data.profiles = {
        [KOFI]: { public_key: KOFI, callsign: 'Kofi', avatar_url: null, bio: 'Tomatoes & bikes', joined_at: '2026-03-01T00:00:00.000Z', archetype: null },
        [OWN]: { public_key: OWN, callsign: 'Wren', avatar_url: null, bio: null, joined_at: '2026-01-05T00:00:00.000Z', archetype: null },
    };
    data.friends = [];
    data.addedFriends = [];
    data.blockedUsers.clear();
    data.unblockedUsers = [];
    data.conversationsCreated = [];
    data.createConvError = null;
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const settle = async (n = 8) => {
    for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function renderProfile() {
    await act(async () => {
        root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(PublicProfileScreen)) as any);
    });
    await settle();
}

describe('Phone public profile message and friend actions (S0)', () => {
    it('shows Message and + Add friend buttons under the banner, and Message opens DM', async () => {
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderProfile();

        const buttons = Array.from(host.querySelectorAll('button'));
        const msgBtn = buttons.find(b => b.textContent?.includes('Message'));
        expect(msgBtn, 'Message button should be rendered').toBeTruthy();

        const addFriendBtn = buttons.find(b => b.textContent?.includes('+ Add friend'));
        expect(addFriendBtn, '+ Add friend button should be rendered').toBeTruthy();

        // Tap Message -> creates DM conversation and navigates to /chat/<conv.id>
        await act(async () => {
            msgBtn!.click();
        });
        await settle();

        expect(data.conversationsCreated.length).toBe(1);
        expect(data.conversationsCreated[0]).toEqual({
            type: 'dm',
            participants: [OWN, KOFI],
            createdBy: OWN,
        });
        expect(nav.pushed).toContain('/chat/conv-dm-123');
    });

    it('shows ✓ Friend when member is already a friend and toggles friend', async () => {
        data.friends = [{ publicKey: KOFI }];
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderProfile();

        const buttons = Array.from(host.querySelectorAll('button'));
        const friendChip = buttons.find(b => b.textContent?.includes('✓ Friend'));
        expect(friendChip, '✓ Friend button should be rendered').toBeTruthy();
        expect(buttons.some(b => b.textContent?.includes('+ Add friend'))).toBe(false);

        // Tap ✓ Friend to remove friend
        await act(async () => {
            friendChip!.click();
        });
        await settle();
        expect(data.friends.length).toBe(0);
    });

    it('tapping + Add friend adds friend locally and changes button to ✓ Friend', async () => {
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderProfile();

        const addFriendBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('+ Add friend'));
        expect(addFriendBtn).toBeTruthy();

        await act(async () => {
            addFriendBtn!.click();
        });
        await settle();

        expect(data.addedFriends).toContain(KOFI);
        const updatedButtons = Array.from(host.querySelectorAll('button'));
        expect(updatedButtons.some(b => b.textContent?.includes('✓ Friend'))).toBe(true);
    });

    it('shows Unblock when member is blocked, and Message is hidden', async () => {
        data.blockedUsers.add(KOFI);
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderProfile();

        // Message should NOT be rendered
        const buttons = Array.from(host.querySelectorAll('button'));
        const msgBtn = buttons.find(b => b.textContent?.includes('Message'));
        expect(msgBtn).toBeFalsy();

        // Row should say "You blocked Kofi." and have Unblock button
        expect(host.textContent).toContain('You blocked Kofi.');
        const unblockBtn = buttons.find(b => b.textContent?.includes('Unblock'));
        expect(unblockBtn).toBeTruthy();

        // Clicking Unblock calls unblockUser
        await act(async () => {
            unblockBtn!.click();
        });
        await settle();

        expect(data.unblockedUsers).toContain(KOFI);
    });

    it('offline / refusal when tapping Message shows alert', async () => {
        data.createConvError = new Error('You are off-grid. Please connect to a node first.');
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderProfile();

        const msgBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Message'));
        await act(async () => {
            msgBtn!.click();
        });
        await settle();

        expect(alerts.said.some(s => s.includes('Connect to your community') || s.includes('off-grid'))).toBe(true);
    });

    it('collaboration chemistry nudge uses DM creation handler with prefill instead of pubkey', async () => {
        data.profiles[OWN] = { ...data.profiles[OWN]!, archetype: 'spark' };
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderProfile();

        const nudgeBtn = host.querySelector(`[aria-label="Nudge Kofi to take the working style quiz"]`);
        expect(nudgeBtn).toBeTruthy();

        await act(async () => {
            (nudgeBtn as HTMLElement).click();
        });
        await settle();

        expect(data.conversationsCreated.length).toBe(1);
        expect(nav.pushed).toEqual([{
            pathname: '/chat/conv-dm-123',
            params: {
                prefill: 'Hey Kofi! Take the 60-second working style quiz on your profile so we can see how we work best together! ⚡',
            },
        }]);
    });
});
