// @vitest-environment jsdom
/**
 * Learn something local on the phone's Home (DESIGN-local-knowledge-amend-fable.md §3.6, slice K7): the card's body (its rows
 * open their page, the newest of the last 14 days led by NEW, "See all ›" spoken "See all of Learn", an owner's amber "N to
 * check ›" and "Add the first thing…" only where this app opens To check and the form), the community card's tappable
 * "{n} things worth knowing", and the card that arrives on a Home its member already arranged: drawn once after their own
 * cards, and Keep on Home, Remove, a move or a drag each writing its stamp in that one save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', summary: 'region' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 304, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
        ListHeaderComponent,
        (data ?? []).length
            ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
            : ListEmptyComponent,
        ListFooterComponent);
    class Value { constructor(public v = 0) {} setValue() {} setOffset() {} stopAnimation() {} interpolate() { return this; } addListener() { return ''; } removeListener() {} removeAllListeners() {} }
    const animation = () => ({ start(cb?: () => void) { cb?.(); }, stop() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList,
        Animated: {
            FlatList, View: el('div'), Value, event: () => () => {}, timing: animation, spring: animation, decay: animation,
            diffClamp: () => new Value(), add: () => new Value(), multiply: () => new Value(), subtract: () => new Value(), modulo: () => new Value(),
        },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: () => {} },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Easing: { out: (f: unknown) => f, cubic: () => 0, ease: () => 0, inOut: (f: unknown) => f },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, setParams() {} },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => ({}),
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
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
// The picture as a phone draws it: its URL, and what it does when the picture will not load.
vi.mock('expo-image', () => ({
    Image: ({ source, onError, onLoad }: { source?: { uri?: string }; onError?: () => void; onLoad?: () => void }) => createElement('img', { 'data-src': source?.uri, onError, onLoad }),
}));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'denied', canAskAgain: false }), getLastKnownPositionAsync: async () => null,
    requestForegroundPermissionsAsync: async () => ({ status: 'denied' }), getCurrentPositionAsync: async () => null,
}));
vi.mock('react-native-maps', () => ({ default: () => null, Marker: () => null, Circle: () => null, PROVIDER_DEFAULT: 'default' }));
vi.mock('@react-native-community/slider', () => ({ default: () => createElement('input', { type: 'range' }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, authenticateAsync: async () => ({ success: false }) }));
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/NewPollModal', () => ({ NewPollModal: () => null }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../home-store', () => ({ readPhoneInterests: async () => [], saveInterests: async () => {} }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
const healed = vi.hoisted(() => ({ calls: [] as Array<[string | null | undefined, string | null | undefined]> }));
vi.mock('../photo-refresh', () => ({
    refreshListingAfterPhotoError: (postId: string | null | undefined, url: string | null | undefined) => { healed.calls.push([postId, url]); return true; },
}));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));


import { LEARN_HOME_WORDS, arrivedStamp, setLanguage, type HomeLearnRow, type LearnHomeLines } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { CommunityBody } from '../../components/home/HomeCardBodies';
import { LearnBody } from '../../components/home/LearnBody';
import { lightColors } from '../../constants/colors';
import {
    HOME_DRAWN, LEARN_OPENS, cardOrder, cardsToAsk, cardsToDraw, isArrivingCard, keepCard, moveCard, moveCardTo, removeCard,
    type HomeAnswer, type HomeLayout,
} from '../home-cards';

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const AT = '2026-11-14T09:00:00.000Z';
const NOW = Date.parse(AT);
const row = (id: string, title: string, isNew?: true): HomeLearnRow => ({
    id, title, line: 'The first line of the page.', topic: 'services', photo: null, checkedAt: AT, helped: 2, pinned: false, outdated: false, ...(isNew ? { isNew } : {}),
});
const THREE: HomeLearnRow[] = [row('k-tip', 'How recycling works at the tip', true), row('k-bins', 'Bins day'), row('k-water', 'Water restrictions')];

async function render(el: ReturnType<typeof createElement>) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, el) as any); });
    await settle();
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

type Taps = { open: string[]; seeAll: number; check: number; first: number; keep: number };
async function showLearn(lines: LearnHomeLines, opts: { toCheck?: boolean; addFirst?: boolean; keep?: boolean } = {}): Promise<Taps> {
    const taps: Taps = { open: [], seeAll: 0, check: 0, first: 0, keep: 0 };
    await render(createElement(LearnBody, {
        lines, community: 'Riverside', colors: lightColors, now: NOW,
        onOpen: (id: string) => { taps.open.push(id); },
        onSeeAll: () => { taps.seeAll++; },
        onToCheck: opts.toCheck ? () => { taps.check++; } : undefined,
        onAddFirst: opts.addFirst ? () => { taps.first++; } : undefined,
        onKeep: opts.keep ? () => { taps.keep++; } : undefined,
    }));
    return taps;
}

describe("the Learn card's body", () => {
    it("draws the day's three pages in Learn's row card; each opens its own page; the newest is led by NEW", async () => {
        const taps = await showLearn({ toCheck: 0, first: false, rows: THREE });
        for (const r of THREE) expect(byId(`home-learn-${r.id}`)?.textContent).toContain(r.title);
        expect(byId('home-learn-k-tip')?.textContent).toContain('NEW');
        expect(byId('home-learn-k-bins')?.textContent).not.toContain('NEW');
        expect(byId('home-learn-k-tip')?.getAttribute('aria-label')).toContain('Local knowledge: How recycling works at the tip');
        act(() => byId('home-learn-k-bins')!.click());
        act(() => byId('home-learn-k-tip')!.click());
        expect(taps.open).toEqual(['k-bins', 'k-tip']);
    });

    it('"See all ›" opens Learn and is spoken "See all of Learn"', async () => {
        const taps = await showLearn({ toCheck: 0, first: false, rows: THREE });
        const all = byId('home-learn-all')!;
        expect(all.textContent).toBe('See all ›');
        expect(all.getAttribute('aria-label')).toBe('See all of Learn');
        act(() => all.click());
        expect(taps.seeAll).toBe(1);
    });

    it('an owner\'s "3 to check ›" leads the card, amber with a ▲ (never colour alone), where To check opens', async () => {
        const taps = await showLearn({ toCheck: 3, first: false, rows: THREE }, { toCheck: true });
        const check = byId('home-learn-check')!;
        expect(check.textContent).toContain('3 to check ›');
        expect(check.textContent).toContain('▲');
        expect(host.textContent!.indexOf('3 to check')).toBeLessThan(host.textContent!.indexOf('How recycling'));
        act(() => check.click());
        expect(taps.check).toBe(1);
        // One waiting: the singular. No rows: no See all.
        await showLearn({ toCheck: 1, first: false, rows: [] }, { toCheck: true });
        expect(byId('home-learn-check')?.textContent).toContain('1 to check ›');
        expect(byId('home-learn-all')).toBeNull();
    });

    it('"Add the first thing worth knowing about {community}" opens the form, where the app opens it', async () => {
        const taps = await showLearn({ toCheck: 0, first: true, rows: [] }, { addFirst: true });
        const first = byId('home-learn-first')!;
        expect(first.textContent).toContain('Add the first thing worth knowing about Riverside ›');
        expect(first.getAttribute('aria-label')).toBe('Add the first thing worth knowing about Riverside');
        act(() => first.click());
        expect(taps.first).toBe(1);
    });

    it('neither owner row without its door, whatever the lines say', async () => {
        await showLearn({ toCheck: 3, first: true, rows: [] });
        expect(byId('home-learn-check')).toBeNull();
        expect(byId('home-learn-first')).toBeNull();
    });

    it('Keep on Home only while the card arrives', async () => {
        await showLearn({ toCheck: 0, first: false, rows: THREE });
        expect(byId('home-learn-keep')).toBeNull();
        const taps = await showLearn({ toCheck: 0, first: false, rows: THREE }, { keep: true });
        expect(byId('home-learn-keep')?.textContent).toBe(LEARN_HOME_WORDS.keep);
        expect(byId('home-learn-keep')?.textContent).toBe('Keep on Home');
        act(() => byId('home-learn-keep')!.click());
        expect(taps.keep).toBe(1);
    });
});

describe('"{n} things worth knowing" on the community card', () => {
    const community = (knowledge?: number) => ({ name: 'Riverside', members: 40, joined7d: 2, tradesThisMonth: 5, commonsPot_c: null, eventsSoon: null, ...(knowledge !== undefined ? { knowledge } : {}) });
    async function showCommunity(card: ReturnType<typeof community>, onLearn?: () => void) {
        await render(createElement(CommunityBody, { card, profile: 'local', invitesOn: true, colors: lightColors, onLearn }));
    }

    it('opens Learn, from 1, singular and plural', async () => {
        let opened = 0;
        await showCommunity(community(6), () => { opened++; });
        const figure = byId('home-community-learn')!;
        expect(figure.textContent).toContain('6 things worth knowing ›');
        expect(figure.getAttribute('role')).toBe('button');
        act(() => figure.click());
        expect(opened).toBe(1);
        await showCommunity(community(1), () => {});
        expect(byId('home-community-learn')?.textContent).toContain('1 thing worth knowing ›');
    });

    it('is not there at 0, where the node left it out (Learn off), or with no door; the rest of the card is as it was', async () => {
        await showCommunity(community(0), () => {});
        expect(byId('home-community-learn')).toBeNull();
        await showCommunity(community(), () => {});
        expect(byId('home-community-learn')).toBeNull();
        await showCommunity(community(6));
        expect(byId('home-community-learn')).toBeNull();
        expect(byId('home-community-row-members')?.textContent).toContain('40 members');
    });

    it('on a card with only its line (a first member), the figure still opens Learn', async () => {
        await render(createElement(CommunityBody, { card: { name: 'Riverside', members: 1, knowledge: 2 }, profile: 'local', invitesOn: true, colors: lightColors, onLearn: () => {} }));
        expect(byId('home-community-learn')?.textContent).toContain('2 things worth knowing ›');
    });
});

describe('the card that arrives on an arranged Home', () => {
    const one = (type: string) => ({ id: type, type });
    const arranged = (cards = [one('market'), one('beans'), one('groups')], dismissed: Record<string, string> = {}): HomeLayout =>
        ({ v: 2, cards, dismissed, updatedAt: AT });
    const STAMP = arrivedStamp('learn');
    const ids = (l: { id: string }[]) => l.map((c) => c.id);
    const answer = (cards: HomeAnswer['cards'], knowledge = true): HomeAnswer => ({
        generatedAt: AT, profile: 'local', features: { beans: true, escrow: true, invites: true, decisions: true, knowledge }, layout: null, cards,
        me: { joinedAt: AT, isKeeper: false, probation: null, interests: ['food'], area: null, firstOffer: true, standing: 'member' },
    });
    const ctx = { interests: ['food'], tuneOpen: false, safetyUp: false, now: NOW };

    it('this build draws it; the phone opens the form (K4) but not To check yet (K4 part 2), so only the first-page row is drawn', () => {
        expect(HOME_DRAWN.has('learn')).toBe(true);
        expect(LEARN_OPENS).toEqual({ addFirst: true });
    });

    it("is drawn once, after the member's own cards, while it has a page to show; asked while it arrives", () => {
        const home = arranged();
        expect(isArrivingCard(home, 'learn')).toBe(true);
        expect(ids(cardOrder(home))).toEqual(['needs', 'market', 'beans', 'groups', 'learn', 'community']);
        expect(cardOrder(home).filter((c) => c.type === 'learn')).toHaveLength(1);
        expect(cardsToAsk(home)).toContain('learn');
        expect(ids(cardsToDraw(answer({ community: { name: 'Riverside', members: 9 }, learn: { rows: THREE } }), home, ctx))).toContain('learn');
        // A member with nothing to show gets no card, arriving or not; an owner's "N to check" needs To check, which this build
        // hasn't yet (K4 part 2); their first-page row opens the form (K4), so it is drawn; Learn off: none.
        expect(ids(cardsToDraw(answer({ community: { name: 'R', members: 9 }, learn: { rows: [] } }), home, ctx))).not.toContain('learn');
        expect(ids(cardsToDraw(answer({ community: { name: 'R', members: 9 }, learn: { rows: [], toCheck: 3 } }), home, ctx))).not.toContain('learn');
        expect(ids(cardsToDraw(answer({ community: { name: 'R', members: 9 }, learn: { rows: [], toCheck: 3, first: true } }), home, ctx))).toContain('learn');
        expect(ids(cardsToDraw(answer({ community: { name: 'R', members: 9 }, learn: { rows: THREE } }, false), home, ctx))).not.toContain('learn');
        // Never for a list that holds it, nor once stamped.
        expect(isArrivingCard(arranged([one('learn'), one('market')]), 'learn')).toBe(false);
        expect(ids(cardOrder(arranged([one('learn'), one('market')])))).toEqual(['needs', 'learn', 'market', 'community']);
        expect(isArrivingCard(arranged(undefined, { [STAMP]: AT }), 'learn')).toBe(false);
        expect(ids(cardOrder(arranged(undefined, { [STAMP]: AT })))).not.toContain('learn');
        // A Home never saved holds it in the default list, after Asked near you: never arriving there.
        expect(isArrivingCard(null, 'learn')).toBe(false);
        expect(ids(cardOrder(null)).indexOf('learn')).toBe(ids(cardOrder(null)).indexOf('asked') + 1);
    });

    it('Keep on Home: last on the list, stamped, in one save; nothing when it is not arriving', () => {
        const kept = keepCard(arranged(), 'learn', NOW + 1)!;
        expect(ids(kept.cards)).toEqual(['market', 'beans', 'groups', 'learn']);
        expect(kept.dismissed[STAMP]).toBe(new Date(NOW + 1).toISOString());
        expect(isArrivingCard(kept, 'learn')).toBe(false);
        expect(keepCard(kept, 'learn', NOW + 2)).toBeNull();
        expect(keepCard(arranged(), 'beans', NOW + 2)).toBeNull();
    });

    it('Remove writes the stamp and leaves the list as it was; it never arrives again', () => {
        const home = arranged();
        const removed = removeCard(home, 'learn', NOW + 1)!;
        expect(removed).not.toBeNull();
        expect(removed.cards).toEqual(home.cards);
        expect(removed.dismissed).toEqual({ [STAMP]: new Date(NOW + 1).toISOString() });
        expect(ids(cardOrder(removed))).not.toContain('learn');
        // Removed once kept: off the list, the stamp kept.
        const off = removeCard(keepCard(home, 'learn', NOW + 1), 'learn', NOW + 2)!;
        expect(ids(off.cards)).toEqual(['market', 'beans', 'groups']);
        expect(off.dismissed[STAMP]).toBe(new Date(NOW + 2).toISOString());
        expect(isArrivingCard(off, 'learn')).toBe(false);
    });

    it('↑ in Arrange keeps it first, then moves it; ↓ from the last place still keeps it, stamped', () => {
        const home = arranged();
        const among = cardOrder(home).filter((c) => c.type !== 'needs' && c.type !== 'community');
        const up = moveCard(home, 'learn', 'up', among, NOW + 1)!;
        expect(ids(up.cards)).toEqual(['market', 'beans', 'learn', 'groups']);
        expect(up.dismissed[STAMP]).toBe(new Date(NOW + 1).toISOString());
        const down = moveCard(home, 'learn', 'down', among, NOW + 1)!;
        expect(ids(down.cards)).toEqual(['market', 'beans', 'groups', 'learn']);
        expect(down.dismissed[STAMP]).toBe(new Date(NOW + 1).toISOString());
        // Another card's move writes no stamp, and the arriving card stays where it is drawn.
        const other = moveCard(home, 'beans', 'up', among, NOW + 1)!;
        expect(other.dismissed).toEqual({});
        expect(ids(cardOrder(other))).toEqual(['needs', 'beans', 'market', 'groups', 'learn', 'community']);
    });

    it('a drag to the top keeps it first, then places it there; a drop where it stands keeps it', () => {
        const home = arranged();
        const among = cardOrder(home).filter((c) => c.type !== 'needs' && c.type !== 'community');
        const top = moveCardTo(home, 'learn', 0, among, NOW + 1)!;
        expect(ids(top.cards)).toEqual(['learn', 'market', 'beans', 'groups']);
        expect(top.dismissed[STAMP]).toBe(new Date(NOW + 1).toISOString());
        const same = moveCardTo(home, 'learn', 3, among, NOW + 1)!;
        expect(ids(same.cards)).toEqual(['market', 'beans', 'groups', 'learn']);
        expect(same.dismissed[STAMP]).toBe(new Date(NOW + 1).toISOString());
    });

    // Review of #3154: Learn is among Arrange's moving cards, so the card above it has a ↓ that is on, and a drop can land in its place.
    it('↓ on the card above it goes under it: Learn is kept first (on the list, stamped), then the two swap, as drawn', () => {
        const home = arranged();
        const among = cardOrder(home).filter((c) => c.type !== 'needs' && c.type !== 'community');
        expect(ids(among)).toEqual(['market', 'beans', 'groups', 'learn']);
        const down = moveCard(home, 'groups', 'down', among, NOW + 1)!;
        expect(down).not.toBeNull();
        expect(ids(down.cards)).toEqual(['market', 'beans', 'learn', 'groups']);
        expect(down.dismissed).toEqual({ [STAMP]: new Date(NOW + 1).toISOString() });
        expect(ids(cardOrder(down))).toEqual(['needs', 'market', 'beans', 'learn', 'groups', 'community']);
    });

    it('a drop into its place lands there, as the drag showed it: Learn kept first and moved up one', () => {
        const home = arranged();
        const among = cardOrder(home).filter((c) => c.type !== 'needs' && c.type !== 'community');
        const dropped = moveCardTo(home, 'market', 3, among, NOW + 1)!;
        expect(dropped).not.toBeNull();
        expect(ids(dropped.cards)).toEqual(['beans', 'groups', 'learn', 'market']);
        expect(dropped.dismissed).toEqual({ [STAMP]: new Date(NOW + 1).toISOString() });
        expect(ids(cardOrder(dropped))).toEqual(['needs', 'beans', 'groups', 'learn', 'market', 'community']);
    });

    it("a move that doesn't reach it leaves it arriving, unstamped; one Home doesn't draw is never kept by a move past its place", () => {
        const home = arranged();
        const among = cardOrder(home).filter((c) => c.type !== 'needs' && c.type !== 'community');
        const dropped = moveCardTo(home, 'market', 2, among, NOW + 1)!;
        expect(ids(dropped.cards)).toEqual(['beans', 'groups', 'market']);
        expect(dropped.dismissed).toEqual({});
        expect(ids(cardOrder(dropped))).toEqual(['needs', 'beans', 'groups', 'market', 'learn', 'community']);
        const drawn = among.filter((c) => c.id !== 'learn');
        expect(moveCard(home, 'groups', 'down', drawn, NOW + 1)).toBeNull();
        expect(moveCardTo(home, 'market', 3, drawn, NOW + 1)).toBeNull();
    });
});
