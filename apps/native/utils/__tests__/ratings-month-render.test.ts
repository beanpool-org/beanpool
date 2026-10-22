// @vitest-environment jsdom
/**
 * Ratings privacy on phone (#1914, Fable 5.1 re-decision 22 Oct 2026):
 * The server sends a third member only the month (createdAt = YYYY-MM-01T12:00:00Z).
 * Other members' reviews must render as 'month-year' (e.g. "OCT 2026"), never a made-up day
 * ("1 OCT 2026" or "2 OCT 2026"). A review written by the viewer ('mine') keeps its day,
 * and the viewer's own profile received reviews keep their days.
 *
 * Rendered at 320 dp × 1.3 font scale in light and dark themes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { formatDate, setLanguage } from '@beanpool/core';

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

const OWN = '9'.repeat(64);
const KOFI = '3'.repeat(64);
const ROSA = '2'.repeat(64);

const who = vi.hoisted(() => ({ value: { identity: { publicKey: '9'.repeat(64), privateKey: '8'.repeat(64), callsign: 'Wren' } } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who.value }));

const currentTheme = vi.hoisted(() => ({ mode: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({
            theme: currentTheme.mode,
            colors: currentTheme.mode === 'dark' ? darkColors : lightColors,
        }),
        useStyles: (make: (t: unknown) => unknown) =>
            make({
                theme: currentTheme.mode,
                colors: currentTheme.mode === 'dark' ? darkColors : lightColors,
            }),
    };
});

const data = vi.hoisted(() => ({
    profiles: {} as Record<string, Record<string, unknown> | null>,
    posts: [] as Record<string, unknown>[],
    ratings: null as null | Record<string, unknown>,
    given: [] as Record<string, unknown>[],
    balance: null as null | Record<string, unknown>,
    friends: [] as unknown[],
    trust: null as null | Record<string, unknown>,
}));

vi.mock('../db', () => ({
    getMemberProfile: vi.fn(async (k: string) => data.profiles[k] ?? null),
    getMemberRatings: vi.fn(async () => data.ratings),
    getMemberPosts: vi.fn(async () => data.posts),
    getBalance: vi.fn(async () => data.balance),
    getRatingsGiven: vi.fn(async () => data.given),
    getFriendsLocal: vi.fn(async () => data.friends),
    isFriendLocal: vi.fn(async () => false),
    getTrustProfile: vi.fn(async () => data.trust),
    vouchMember: vi.fn(async () => undefined),
    updateMemberProfile: vi.fn(async () => undefined),
}));

vi.mock('../blocklist', () => ({ blockUser: vi.fn(async () => undefined), unblockUser: vi.fn(async () => true), isUserBlocked: vi.fn(async () => false), BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
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
    return { LocalCommunityMark: ({ text }: { text: string }) => h('span', { 'data-testid': 'local-line' }, text) };
});

import { LanguageProvider } from '../../components/LanguageProvider';
import PublicProfileScreen from '../../app/public-profile';
import { unfit } from './profile-events-words-harness';

const TRUST = (over: Record<string, unknown> = {}) => ({
    tier: { name: 'Newcomer', emoji: '🌱' }, earnedCredit: 0, stats: { tradeCount: 0, uniquePartners: 0 }, completionRate: null,
    risk: { band: 'green', headline: 'Trust Profile', reasons: [], tips: [] },
    vouchedInBy: { kind: 'admin', publicKey: null, callsign: null, avatarUrl: null, tier: null },
    mutualCount: 0, mutualConnections: [],
    joinedAt: '2026-03-01T00:00:00.000Z', lastActiveAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), elderVouch: null,
    ...over,
});

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
    currentTheme.mode = 'light';
    data.profiles = {
        [KOFI]: { public_key: KOFI, callsign: 'Kofi', avatar_url: null, bio: 'Gardener', joined_at: '2026-03-01T00:00:00.000Z', archetype: null },
        [OWN]: { public_key: OWN, callsign: 'Wren', avatar_url: null, bio: null, joined_at: '2026-01-05T00:00:00.000Z', archetype: null },
    };
    data.posts = [];
    data.given = [];
    data.balance = { balance: 10, earnedCredit: 20, tier: { name: 'Resident', emoji: '🏡' }, trustStats: { tradeCount: 2 }, canVouch: false };
    data.friends = [];
    data.trust = TRUST();
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setLanguage('en');
});

const settle = async (n = 8) => {
    for (let i = 0; i < n; i++) {
        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });
    }
};

async function renderProfile(lang = 'en') {
    await act(async () => {
        root.render(
            createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang },
                createElement(PublicProfileScreen)
            ) as any
        );
    });
    await settle();
}

const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};

describe('ratings month display on phone (Fable 5.1 privacy decision)', () => {
    it("another member's review stamped 2026-10-01T12:00:00Z renders month-year ('OCT 2026') without a false day, while mine row keeps its day", async () => {
        data.ratings = {
            average: 5,
            count: 2,
            asProvider: { average: 5 },
            asReceiver: { average: 5 },
            ratings: [
                {
                    // Third-party review: server sent month only (1st at noon UTC)
                    stars: 5,
                    role: 'provider',
                    createdAt: '2026-10-01T12:00:00Z',
                    comment: 'Great harvest delivery.',
                    // mine is not true
                },
                {
                    // Viewer's own review on Kofi's profile: has exact day
                    stars: 4,
                    role: 'receiver',
                    createdAt: '2026-10-15T09:00:00Z',
                    comment: 'My review of Kofi.',
                    mine: true,
                },
            ],
        };
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };
        await renderProfile('en');

        // Switch to Reviews tab
        const reviewsTab = Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Reviews (2)'));
        await click(reviewsTab, 'Reviews tab');

        // Locate dateText elements in the review cards
        const comment1 = Array.from(host.querySelectorAll('span')).find((s) => s.textContent?.includes('Great harvest delivery.'));
        expect(comment1, 'Comment 1 found').toBeTruthy();
        const card1 = comment1!.closest('div')!;
        const date1 = card1.querySelector('span[data-font="10"]');
        expect(date1, 'Date 1 element found').toBeTruthy();

        const comment2 = Array.from(host.querySelectorAll('span')).find((s) => s.textContent?.includes('My review of Kofi.'));
        expect(comment2, 'Comment 2 found').toBeTruthy();
        const card2 = comment2!.closest('div')!;
        const date2 = card2.querySelector('span[data-font="10"]');
        expect(date2, 'Date 2 element found').toBeTruthy();

        // 1. Third-party review: formatted as month-year ("OCT 2026"), NEVER a day (no "1 OCT", no "2 OCT", no day number)
        const expectedMonthYear = formatDate(new Date('2026-10-01T12:00:00Z'), 'month-year', { caps: true });
        expect(date1!.textContent?.trim()).toBe(expectedMonthYear);
        expect(date1!.textContent).not.toMatch(/\b(1|2)\s+OCT/i);
        expect(date1!.textContent).not.toMatch(/\b[0-9]{1,2}\s+[A-Za-z]/);

        // 2. Viewer's own review ('mine: true'): keeps its day ("15 OCT 2026")
        const expectedMineDay = formatDate(new Date('2026-10-15T09:00:00Z'), 'day-month-year', { caps: true });
        expect(date2!.textContent?.trim()).toBe(expectedMineDay);
    });

    it("the viewer's own profile keeps days on received reviews", async () => {
        data.ratings = {
            average: 5,
            count: 1,
            asProvider: { average: 5 },
            asReceiver: { average: null },
            ratings: [
                {
                    stars: 5,
                    role: 'provider',
                    createdAt: '2026-10-01T12:00:00Z',
                    comment: 'Always reliable partner.',
                },
            ],
        };
        // Viewer is looking at their own profile (isSelf)
        nav.params = { publicKey: OWN };
        await renderProfile('en');

        // On own profile, tab is labelled "Received (1)"
        const receivedTab = Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Received (1)'));
        await click(receivedTab, 'Received tab');

        const comment = Array.from(host.querySelectorAll('span')).find((s) => s.textContent?.includes('Always reliable partner.'));
        expect(comment, 'Comment found').toBeTruthy();
        const card = comment!.closest('div')!;
        const dateEl = card.querySelector('span[data-font="10"]');
        expect(dateEl, 'Date element found').toBeTruthy();

        // Own profile keeps exact day
        const expectedDay = formatDate(new Date('2026-10-01T12:00:00Z'), 'day-month-year', { caps: true });
        expect(dateEl!.textContent?.trim()).toBe(expectedDay);
    });

    it('holds at 320 dp × 1.3 font scale in light and dark themes', async () => {
        data.ratings = {
            average: 5,
            count: 2,
            asProvider: { average: 5 },
            asReceiver: { average: 5 },
            ratings: [
                { stars: 5, role: 'provider', createdAt: '2026-10-01T12:00:00Z', comment: 'Delivered pumpkins.' },
                { stars: 4, role: 'receiver', createdAt: '2026-10-15T09:00:00Z', comment: 'Brought seeds.', mine: true },
            ],
        };
        nav.params = { publicKey: KOFI, callsign: 'Kofi' };

        // Light theme
        currentTheme.mode = 'light';
        await renderProfile('en');
        const reviewsTabLight = Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Reviews (2)'));
        await click(reviewsTabLight, 'Reviews tab light');
        // Unfit check at 320dp width
        expect(unfit(host, 320 - 32 - 28, ['Kofi', 'Wren', 'Delivered pumpkins.', 'Brought seeds.'])).toEqual([]);

        // Dark theme
        act(() => root.unmount());
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        currentTheme.mode = 'dark';
        await renderProfile('en');
        const reviewsTabDark = Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Reviews (2)'));
        await click(reviewsTabDark, 'Reviews tab dark');
        expect(unfit(host, 320 - 32 - 28, ['Kofi', 'Wren', 'Delivered pumpkins.', 'Brought seeds.'])).toEqual([]);
    });
});
