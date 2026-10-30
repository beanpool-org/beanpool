// @vitest-environment jsdom
/**
 * Find a community's lines about nothing near (app/find-community.tsx), in the member's language: core's
 * FIND_COMMUNITY_WORDS are word() keys the screen shows through t(), and the far line is core's farLine, which
 * translates both halves, so it is one language, never "No community near you yet." in English before a French lead
 * (deciding review of #2152, inline comment on find-community.ts:84). The web's findBody is held to the same in
 * apps/pwa/src/lib/home-cards.test.ts.
 *
 * Rendered for real, as set-up-server-entry-render.test.ts does: react-dom in jsdom, React Native's host components as
 * plain tags, the screen's network and storage stubbed at their modules. Core's language is set as the provider sets it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
        Alert: { alert: vi.fn() },
        Linking: { openURL: vi.fn(async () => undefined) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() }, useLocalSearchParams: () => ({}), ErrorBoundary: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => undefined) }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied', canAskAgain: true })),
    getLastKnownPositionAsync: vi.fn(async () => null),
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
    getCurrentPositionAsync: vi.fn(async () => null),
    Accuracy: { Balanced: 3 },
}));
// The member's community is the global one: since slice S3 an account with no community in use is waiting to be let in,
// and the screen signs nothing to the global community for it (app/find-community.tsx `inCommunity`).
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://global.beanpool.org' : null)), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: 'light', colors: lightColors });
    return { useTheme: ctx, useStyles: (factory: (c: ReturnType<typeof ctx>) => unknown) => factory(ctx()) };
});
const who = vi.hoisted(() => ({ identity: { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'marty' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
// What the node lists from the member's typed town: set per case.
const listing = vi.hoisted(() => ({ communities: [] as Record<string, unknown>[], fetchedAt: '2026-10-14T08:00:00.000Z' as string | null }));
vi.mock('../community-directory', async () => {
    const core = await import('@beanpool/core');
    return {
        fetchCommunities: vi.fn(async () => ({ ok: true, value: { communities: listing.communities, total: listing.communities.length, fetchedAt: listing.fetchedAt } })),
        fetchGlobalHome: vi.fn(async () => ({ ok: true, value: { watches: [] } })),
        watchPlace: vi.fn(), unwatchPlace: vi.fn(),
        communityLabel: (c: { name: string }) => c.name, communityFacts: () => '',
        // As utils/community-directory.ts has it (tested there): core's rule, in the member's language.
        notAnsweringLine: (c: { lastSeenAt?: string | null }) => (core.notAnsweringLately(c.lastSeenAt) ? core.t(core.FIND_COMMUNITY_WORDS.notAnswering) : null),
    };
});
vi.mock('../knock', () => ({
    sendKnock: vi.fn(), readKnockStatus: vi.fn(), rememberedKnocks: vi.fn(async () => []), rememberKnock: vi.fn(), forgetKnock: vi.fn(),
    cancelKnock: vi.fn(), cancelledKnocks: vi.fn(async () => ({})), KNOCK_MESSAGES: {},
    knockCardState: vi.fn(() => ({ kind: 'ask' })), knockFormProblem: vi.fn(() => null), KNOCK_MESSAGE_CHARS: 280, KNOCK_CALLSIGN_CHARS: 20,
}));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: vi.fn(), joinedNudge: vi.fn(), PROTECT_REDIRECT: '/x', HOME_REDIRECT: '/y' }));
// A town the member typed, so the list is nearest first from a place.
vi.mock('../typed-place', () => ({
    readTypedPlace: vi.fn(async () => ({ lat: -28.65, lng: 153.6, name: 'Mullumbimby' })), saveTypedPlace: vi.fn(), forgetTypedPlace: vi.fn(async () => undefined),
    nearLine: () => '', LOCATION_NOTES: { off: 'off', failed: 'failed' },
}));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => null) }));
vi.mock('../node-claim', () => ({ readClaimStatus: vi.fn(async () => ({ kind: 'claimed' })) }));
vi.mock('../../components/AddressSearch', () => ({ AddressSearch: () => null }));

import { FIND_COMMUNITY_WORDS, pluralKey, setLanguage } from '@beanpool/core';
import FindCommunityScreen from '../../app/find-community';

const FAR_ONE = 'The nearest listed is far from here:';
const FAR_MANY = 'The nearest listed are far from here:';
// A French catalog that gives every one of these keys a value (the drafting pass will write the real ones).
const FR = {
    [FIND_COMMUNITY_WORDS.noneNear]: 'Aucune communauté près de chez vous pour l’instant.',
    [FIND_COMMUNITY_WORDS.notLoaded]: 'La liste des communautés n’est pas disponible. Réessayez bientôt.',
    [pluralKey(FAR_ONE, FAR_MANY)]: { one: 'La plus proche est loin d’ici :', other: 'Les plus proches sont loin d’ici :' },
    [FIND_COMMUNITY_WORDS.notAnswering]: 'Ne répond pas ces derniers temps',
};
const lismore = (key: string, distanceKm: number) => ({
    key, name: `Lismore ${key}`, url: `https://${key}.example`, lat: null, lng: null, radiusKm: null, memberCount: 12, contactEmail: null, contactPhone: null, distanceKm,
});

async function render(): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(FindCommunityScreen as any) as unknown as Parameters<Root['render']>[0]); });
    // The typed town, then the list read from it.
    await act(async () => {});
    await act(async () => {});
    return host;
}
const line = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

beforeEach(() => {
    document.body.innerHTML = '';
    listing.communities = [];
    listing.fetchedAt = '2026-10-14T08:00:00.000Z';
});
afterEach(() => setLanguage('en'));

describe('Find a community says "nothing near" in one language', () => {
    it('in English, as it always has', async () => {
        listing.communities = [lismore('a', 12_489)];
        expect(line(await render(), 'find-far')).toBe(`No community near you yet. ${FAR_ONE}`);
    });

    it('the far line is all French when the catalog has both halves', async () => {
        setLanguage('fr', [FR]);
        listing.communities = [lismore('a', 12_489)];
        expect(line(await render(), 'find-far')).toBe('Aucune communauté près de chez vous pour l’instant. La plus proche est loin d’ici :');
        document.body.innerHTML = '';
        listing.communities = [lismore('a', 12_489), lismore('b', 12_530)];
        expect(line(await render(), 'find-far')).toBe('Aucune communauté près de chez vous pour l’instant. Les plus proches sont loin d’ici :');
    });

    it('"none" and "not loaded" are French too', async () => {
        setLanguage('fr', [FR]);
        expect(line(await render(), 'find-empty')).toBe(FR[FIND_COMMUNITY_WORDS.noneNear]);
        document.body.innerHTML = '';
        listing.fetchedAt = null;
        expect(line(await render(), 'find-empty')).toBe(FR[FIND_COMMUNITY_WORDS.notLoaded]);
    });
});

describe('a community gone quiet says so under its name (front doors S13)', () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const quiet = (host: HTMLElement, key: string) => line(host, `find-not-answering-${key}`);

    it('"Not answering lately" past 36 h since its last push, and not before; Ask to join stays', async () => {
        listing.communities = [
            { ...lismore('a', 12), lastSeenAt: hoursAgo(40) },
            { ...lismore('b', 20), lastSeenAt: hoursAgo(35) },
            { ...lismore('c', 30), lastSeenAt: hoursAgo(2) },
            { ...lismore('d', 40), lastSeenAt: null },
        ];
        const host = await render();
        expect(quiet(host, 'a')).toBe(FIND_COMMUNITY_WORDS.notAnswering);
        expect(quiet(host, 'b')).toBeNull();
        expect(quiet(host, 'c')).toBeNull();
        expect(quiet(host, 'd')).toBeNull();
        expect(host.querySelector('[aria-label="Ask to join Lismore a"]')).not.toBeNull();
    });

    it('in the member\'s language', async () => {
        setLanguage('fr', [FR]);
        listing.communities = [{ ...lismore('a', 12), lastSeenAt: hoursAgo(40) }];
        expect(quiet(await render(), 'a')).toBe('Ne répond pas ces derniers temps');
    });
});
