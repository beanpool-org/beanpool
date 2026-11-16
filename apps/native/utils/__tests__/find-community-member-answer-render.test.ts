// @vitest-environment jsdom
/**
 * Find a community's row for a community this phone is a member of (app/find-community.tsx; addresses S5, §3.6): the
 * community is asked once per row key while the screen is open (utils/member-here.ts askMemberHere), and its answer is
 * kept even when the list reloads while the ask is out (#3251 round 2 review: a search, the place arriving or Try again
 * dropped the answer, while the key stayed asked, so the member's own row knocked for the rest of the visit).
 *
 *   - an ask still out when the list reloads: its "a member" answer lands, and the row opens;
 *   - an answer for an account the phone no longer shows is never applied to the next one (that account is asked again).
 *
 * Rendered for real, as find-community-words-render.test.ts renders it: react-dom in jsdom, React Native's host components
 * as plain tags, the screen's network and storage stubbed at their modules.
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
vi.mock('expo-router', () => ({ router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() }, useLocalSearchParams: () => ({}), useFocusEffect: () => {}, ErrorBoundary: () => null }));
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
// The community in front is another one (the global community), so the member's row offers Open, not "you are here".
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://global.example' : null)), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: 'light', colors: lightColors });
    return { useTheme: ctx, useStyles: (factory: (c: ReturnType<typeof ctx>) => unknown) => factory(ctx()) };
});
const who = vi.hoisted(() => ({ identity: { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'river' } as any, setIdentity: () => {} }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
// Each read of the directory gives a new list (a new array, as the node's answer is), the same rows.
const listing = vi.hoisted(() => ({ reads: 0 }));
const ROW = { key: 'riverside-key', name: 'Riverside', url: 'https://riverside.example', lat: null, lng: null, radiusKm: null, memberCount: 12, contactEmail: null, contactPhone: null, distanceKm: 3 };
vi.mock('../community-directory', () => ({
    fetchCommunities: vi.fn(async () => { listing.reads += 1; return { ok: true, value: { communities: [{ ...ROW }], total: 1, fetchedAt: '2026-11-16T08:00:00.000Z' } }; }),
    fetchGlobalHome: vi.fn(async () => ({ ok: true, value: { watches: [] } })),
    watchPlace: vi.fn(), unwatchPlace: vi.fn(),
    communityLabel: (c: { name: string }) => c.name, communityFacts: () => '',
    notAnsweringLine: () => null, promiseLine: () => null,
}));
vi.mock('../knock', () => ({
    sendKnock: vi.fn(), readKnockStatus: vi.fn(), rememberedKnocks: vi.fn(async () => []), rememberKnock: vi.fn(), forgetKnock: vi.fn(),
    cancelKnock: vi.fn(), cancelledKnocks: vi.fn(async () => ({})), KNOCK_MESSAGES: { member: 'You are a member here.' },
    knockCardState: vi.fn(() => ({ kind: 'ask' })), knockFormProblem: vi.fn(() => null), KNOCK_MESSAGE_CHARS: 280, KNOCK_CALLSIGN_CHARS: 20,
}));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: vi.fn(), joinedNudge: vi.fn(), PROTECT_REDIRECT: '/x', HOME_REDIRECT: '/y' }));
vi.mock('../typed-place', () => ({
    readTypedPlace: vi.fn(async () => ({ lat: -28.65, lng: 153.6, name: 'Riverside' })), saveTypedPlace: vi.fn(), forgetTypedPlace: vi.fn(async () => undefined),
    nearLine: () => '', LOCATION_NOTES: { off: 'off', failed: 'failed' },
}));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => null) }));
vi.mock('../node-claim', () => ({ readClaimStatus: vi.fn(async () => ({ kind: 'claimed' })) }));
vi.mock('../../components/AddressSearch', () => ({ AddressSearch: () => null }));
// The phone holds Riverside's record (it is one of its communities), and the records are read.
vi.mock('../community-record', async (importOriginal) => ({ ...(await importOriginal<object>()), communityRecordsReady: vi.fn(async () => undefined) }));
const RECORD = { id: 'https://riverside.example', using: 'https://riverside.example', peerId: 'riverside-key' };
vi.mock('../community-index', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    communityRecordByKey: (key: string) => (key === RECORD.peerId ? RECORD : null),
    directoryRowCommunity: (row: { key: string }) => (row.key === RECORD.peerId ? { using: RECORD.using, inFront: false, askList: false } : null),
    recordAddresses: () => [RECORD.using],
}));
// The community's answer to "is this key a member here?": held until the case lets it go, one ask at a time.
const asks = vi.hoisted(() => ({ list: [] as { key: string; resolve: (member: boolean) => void }[] }));
vi.mock('../member-here', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    askMemberHere: vi.fn((_where: unknown, identity: { publicKey: string }) => new Promise<boolean>((resolve) => { asks.list.push({ key: identity.publicKey, resolve }); })),
}));

import FindCommunityScreen from '../../app/find-community';

let host: HTMLElement;
let root: Root;
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const openButton = () => host.querySelector('[aria-label="Open Riverside"]');
const askToJoin = () => host.querySelector('[aria-label="Ask to join Riverside"]');
async function type(el: HTMLInputElement, value: string) {
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
async function render() {
    await act(async () => { root.render(createElement(FindCommunityScreen as any) as any); });
    await settle();
}
/** The member types into the search box: the list is read again after the box's 400 ms wait. */
async function searchFor(words: string) {
    const readsBefore = listing.reads;
    await type(byId('find-address') as HTMLInputElement, words);
    for (let i = 0; i < 40 && listing.reads === readsBefore; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    await settle();
    expect(listing.reads).toBe(readsBefore + 1);
}

beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    listing.reads = 0;
    asks.list = [];
    who.identity = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'river' };
});
afterEach(async () => { await act(async () => { root.unmount(); }); });

describe("the member's own row opens once the community answers, whatever reloads meanwhile (#3251)", () => {
    it('answered before any reload: Open (the ordinary case)', async () => {
        await render();
        expect(asks.list).toHaveLength(1);
        expect(askToJoin()).not.toBeNull();
        await act(async () => { asks.list[0].resolve(true); });
        await settle();
        expect(openButton()).not.toBeNull();
        expect(askToJoin()).toBeNull();
    });

    it('a search reloads the list while the ask is out: its answer still lands, and the row opens (asked once)', async () => {
        await render();
        expect(asks.list).toHaveLength(1);
        await searchFor('river');
        // The row's key was asked already: no second ask.
        expect(asks.list).toHaveLength(1);
        expect(askToJoin()).not.toBeNull();
        await act(async () => { asks.list[0].resolve(true); });
        await settle();
        expect(openButton()).not.toBeNull();
        expect(askToJoin()).toBeNull();
    });

    it('"not a member" landing after a reload keeps the knock', async () => {
        await render();
        await searchFor('river');
        await act(async () => { asks.list[0].resolve(false); });
        await settle();
        expect(openButton()).toBeNull();
        expect(askToJoin()).not.toBeNull();
    });

    it('an answer for the account the phone showed before is not applied to the next one; that one is asked again', async () => {
        await render();
        expect(asks.list).toHaveLength(1);
        const first = asks.list[0];
        expect(first.key).toBe('ab'.repeat(32));
        who.identity = { publicKey: 'ef'.repeat(32), privateKey: '01'.repeat(32), callsign: 'creek' };
        await render();
        expect(asks.list).toHaveLength(2);
        expect(asks.list[1].key).toBe('ef'.repeat(32));
        // The earlier account's "a member" comes in late: the row still knocks for this one.
        await act(async () => { first.resolve(true); });
        await settle();
        expect(openButton()).toBeNull();
        expect(askToJoin()).not.toBeNull();
        // This account's own answer opens it.
        await act(async () => { asks.list[1].resolve(true); });
        await settle();
        expect(openButton()).not.toBeNull();
    });
});
