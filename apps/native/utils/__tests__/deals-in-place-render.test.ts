// @vitest-environment jsdom
/**
 * Slice S6c as drawn (DESIGN-no-switch-messaging-fable.md §6), at 320 dp with 1.3× text, light and dark: the deals of a chat in
 * place (app/chat/[id].tsx, rendered for real: react-dom in jsdom, React Native's host components as tags, utils/db as a
 * stand-in that records every call). Their steps show only once the chat's own community has answered about them, each asks as
 * it asks at home and is handed that community by name; what isn't done there says so and offers the move. Where each call then
 * goes, and what is refused, is deals-in-place-table.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
    Loader._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
});
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface Alerted { title: string; body?: string; buttons?: Array<{ text?: string; style?: string; onPress?: () => unknown }> }
const alerts = vi.hoisted(() => ({ list: [] as any[] }));
/** Every render of a host element, watched for some words (`watch`): whether any render, however brief, drew them. */
const drawn = vi.hoisted(() => ({ watch: null as null | string, saw: false }));
const events = vi.hoisted(() => ({ on: {} as Record<string, Set<() => void>> }));
vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, any> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, disabled, value, onChangeText } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(typeof props.style === 'function' ? props.style({}) : props.style)) };
        if (drawn.watch && [children, accessibilityLabel].flat(9).some((c) => typeof c === 'string' && c.includes(drawn.watch!))) drawn.saw = true;
        if (onPress && !disabled) attrs.onClick = (e: any) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (disabled) attrs['data-disabled'] = '1';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (placeholder) attrs.placeholder = placeholder;
        if (onChangeText) { attrs.onChange = (e: any) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), Image: el('img'), TouchableOpacity: el('button'),
        FlatList: () => null, ActivityIndicator: () => null,
        Modal: ({ visible, children }: any) => (visible ? createElement('div', { 'data-modal': '1' }, children) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string, buttons?: any[]) => { alerts.list.push({ title, body, buttons }); } },
        Linking: { openURL: async () => {} },
        DeviceEventEmitter: { addListener: (n: string, fn: () => void) => { (events.on[n] ??= new Set()).add(fn); return { remove() { events.on[n]?.delete(fn); } }; }, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }) }, NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
/** The screen's focus effect, to leave the chat and come back as a phone does. */
const focus = vi.hoisted(() => ({ cb: null as null | (() => void | (() => void)), end: null as null | (() => void) }));
const nav = vi.hoisted(() => ({ went: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    const go = (to: unknown) => { nav.went.push(to); };
    return {
        router: { push: go, navigate: go, replace: go, back() {}, setParams() {}, canGoBack: () => true },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => { focus.cb = cb; focus.end = (cb() as any) ?? null; return () => { focus.end?.(); focus.end = null; }; }, [cb]),
        useIsFocused: () => true, useLocalSearchParams: () => params.now, Stack: { Screen: () => null }, ErrorBoundary: () => null,
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async (k: string) => store.map.get(k) ?? null), setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }), removeItem: vi.fn(async (k: string) => { store.map.delete(k); }), getAllKeys: vi.fn(async () => [...store.map.keys()]) } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-image-manipulator', () => ({ SaveFormat: {} }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'a-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/', documentDirectory: '/tmp/doc/', getInfoAsync: async () => ({ exists: false }) }));
vi.mock('expo-file-system', () => ({}));
vi.mock('expo-notifications', () => ({}));
vi.mock('expo-device', () => ({}));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
vi.mock('expo-linking', () => ({ createURL: (p: string) => `beanpool://${p}` }));
vi.mock('react-native-worklets', () => ({ scheduleOnRN: () => {} }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: any) => createElement('div', null, children) }));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: any) => createElement('div', null, children);
    return { KeyboardAvoidingView: pass, KeyboardController: { dismiss: async () => {}, isVisible: () => false, setInputMode: () => {}, setDefaultMode: () => {} }, AndroidSoftInputModes: {}, useKeyboardState: (pick: any) => pick({ isVisible: false, height: 0 }), useKeyboardHandler: () => {} };
});
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {} }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: theme.dark ? 'dark' : 'light', colors: theme.dark ? darkColors : lightColors, patternEnabled: false });
    return { useTheme: ctx, useStyles: (make: (c: unknown) => unknown) => make(ctx()) };
});
const ME = { publicKey: 'me-key', privateKey: 'me-priv', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'member' }) }));
/** What the community in use says of itself (the worldwide one); the chat's own community's is this phone's kept copy (store). */
const here = vi.hoisted(() => ({ features: {} as Record<string, unknown> }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'global', features: here.features }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/CurrencyDisplay', () => ({ CurrencyDisplay: ({ amount }: any) => createElement('b', null, `${amount} B`) }));
vi.mock('../../components/chat/ChatMessageList', () => ({
    ChatMessageList: (p: any) => createElement('div', null, ...(p.items || []).map((it: any, i: number) => createElement('div', { key: i }, p.renderMessage(it)))), scrollChatToBottom: () => {},
}));
vi.mock('../../components/chat/ChatComposer', async () => { const R = await import('react'); return { ChatComposer: R.forwardRef(() => null) }; });
vi.mock('../../components/chat/useChatSoftInputMode', () => ({ useChatSoftInputMode: () => {} }));
vi.mock('../../components/NotifyLine', () => ({ chatMoment: () => '', takeNotifyMoment: () => null, useNotifyLine: () => ({ offer: async () => false, line: null, view: null }), useScreenShowing: () => true }));
vi.mock('../blocklist', () => ({ isUserBlocked: async () => false, getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'x', blockUser: async () => true }));
vi.mock('../chat-route', () => ({ routeChat: async () => ({ view: 'dm', screenId: 'dm1' }), screenIdOf: (s: string) => s.toLowerCase() }));
const moved = vi.hoisted(() => ({ run: vi.fn(async (..._a: unknown[]): Promise<string> => 'switched') }));
vi.mock('../open-in-community', () => ({ openInCommunity: moved.run }));
/** Every call of utils/db, in order: its name and what it was handed; what it answers, by name. */
const calls = vi.hoisted(() => ({ list: [] as Array<[string, any[]]>, answer: {} as Record<string, unknown> }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn([], (name, args) => {
    calls.list.push([name, args]);
    if (name === 'whileChatInPlace') return (args[1] as () => Promise<unknown>)();
    const a = calls.answer[name];
    if (typeof a === 'function') return (a as (...x: unknown[]) => Promise<unknown>)(...args);
    return name in calls.answer ? Promise.resolve(a) : undefined;
}));

import { setLanguage } from '@beanpool/core';
import ChatRoute from '../../app/chat/[id]';
import { PUSH_RECEIVED_EVENT } from '../app-events';
import { darkColors, lightColors } from '../../constants/colors';

const HERE = 'https://hilltop.example';
const RIVER = 'https://riverside.example';
const NAME = 'Riverside and the Upper Valley Neighbourhood Community';
const KOFI = 'kofi-key';
const HELD = { txId: 'tx-held', postId: 'p-ladder', postTitle: 'Borrow a long ladder', status: 'pending', buyerPubkey: ME.publicKey, sellerPubkey: KOFI, iAmBuyer: true, amount_c: 1250, createdAt: '2026-11-20T00:00:00.000Z' };
const EGGS = { ...HELD, txId: 'tx-eggs', postId: 'p-eggs', postTitle: 'Duck eggs', amount_c: 300, createdAt: '2026-11-19T00:00:00.000Z' };
const DUE = { ...HELD, txId: 'tx-due', postId: 'p-mow', postTitle: 'Mowing', buyerPubkey: KOFI, sellerPubkey: ME.publicKey, iAmBuyer: false, amount_c: 700 };
const DONE = { ...HELD, txId: 'tx-done', postId: 'p-jam', postTitle: 'Jam', status: 'completed', iRated: false };
const ASKED = { ...HELD, txId: 'tx-ask', postId: 'p-saw', postTitle: 'Chainsaw', status: 'requested', buyerPubkey: KOFI, sellerPubkey: ME.publicKey, iAmBuyer: false, postAuthorPublicKey: ME.publicKey };
const STANDING = {
    ...HELD, txId: 'tx-veg', postId: 'p-veg', postTitle: 'Veg box', status: 'completed', iRated: true, standing_id: 'sd-1', period_no: 2, amount_c: 2000,
    standing: JSON.stringify({ phase: 'paid', beans_c: 2000, unit: 'week', nextDueAt: '2026-11-27T00:00:00.000Z', startsAt: '2026-11-06T00:00:00.000Z', stopped: false, asksLeft: 2, ask: null }),
};
const all = (...rows: any[]) => new Map(rows.map((d) => [d.txId, {}]));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    setLanguage('en');
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    calls.list.length = 0;
    alerts.list.length = 0;
    nav.went.length = 0;
    events.on = {};
    theme.dark = false;
    moved.run.mockClear();
    moved.run.mockImplementation(async () => 'switched');
    store.map.clear();
    store.map.set('beanpool_anchor_url', HERE);
    store.map.set('beanpool_saved_nodes', JSON.stringify([{ url: HERE }, { url: RIVER, name: NAME }]));
    here.features = {};
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(async () => { await act(async () => { root.unmount(); }); });
const settle = async (n = 14) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

/** The chat with Kofi, in place (or in the community in use), holding `deals`; `there`: what its own community answers of them. */
async function open(deals: any[], there: unknown, o: { inPlace?: boolean; over?: Record<string, unknown> } = {}): Promise<void> {
    const inPlace = o.inPlace !== false;
    params.now = inPlace ? { id: 'dm1', community: RIVER } : { id: 'dm1' };
    calls.answer = {
        heldChatIsDm: true, heldChatIsGroup: false, closeHeldCopies: undefined, getConversation: { name: 'Kofi', otherPubkey: KOFI, type: 'dm', request: null, listed: 1 },
        getMessages: [], getDmKeyChange: null, getDmKeyCodeInfo: null, getKnownChatMute: null, oldestUnreadAt: null, markConversationRead: true, syncSingleConversation: true, syncMessages: true,
        getDb: { getAllAsync: async () => [], getFirstAsync: async () => null, runAsync: async () => ({}) },
        enterChatInPlace: undefined, leaveChatInPlace: Promise.resolve(), getDealsBetween: deals, syncDealsBetween: there,
        completeMarketplaceTransaction: { success: true }, cancelMarketplaceTransaction: { success: true }, stopStandingDeal: { success: true }, lowerStandingPeriod: { success: true }, submitRating: { success: true },
        ...o.over,
    };
    await act(async () => { root.render(createElement(ChatRoute) as any); });
    await settle();
    expect(host.textContent).toContain('Kofi');
}
const of = (name: string) => calls.list.filter(([n]) => n === name).map(([, a]) => a);
const buttons = () => Array.from(host.querySelectorAll<HTMLElement>('button'));
const reading = (words: string) => buttons().find((b) => b.textContent?.trim() === words) ?? null;
/** The release bar's Cancel: a card's has a label of its own. */
const barCancel = () => buttons().find((b) => b.textContent === 'Cancel' && !b.getAttribute('aria-label')) ?? null;
const labelled = (label: string) => buttons().find((b) => b.getAttribute('aria-label') === label) ?? null;
const press = async (b: HTMLElement | null, what: string) => { expect(b, what).not.toBeNull(); await act(async () => { b!.click(); }); await settle(); };
const lastAlert = (): Alerted => alerts.list[alerts.list.length - 1];
/** Answers the dialog on screen with the button reading `text`. */
const answerAlert = async (text: string) => { const b = lastAlert().buttons?.find((x) => x.text === text); expect(b, `"${text}" in ${JSON.stringify(lastAlert())}`).toBeTruthy(); await act(async () => { await b!.onPress?.(); }); await settle(); };
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
const MONEY = ['completeMarketplaceTransaction', 'cancelMarketplaceTransaction', 'stopStandingDeal', 'lowerStandingPeriod', 'answerStandingAsk', 'withdrawStandingAsk', 'submitRating'];
const moneyCalls = () => calls.list.filter(([n]) => MONEY.includes(n));
/** WCAG contrast of two hex colours. */
const contrast = (a: string, b: string): number => {
    const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

for (const dark of [false, true]) describe(`${dark ? 'dark' : 'light'}, 320 dp × 1.3: the deals of a chat in place`, () => {
    const colors = dark ? darkColors : lightColors;
    beforeEach(() => { theme.dark = dark; });

    it('one deal of mine to release: its header, what it holds (the community in use has Beans off), Release and Cancel, whole at 320', async () => {
        here.features = { beans: false };
        await open([HELD], all(HELD));
        expect(host.textContent).toContain(NAME);
        expect(host.textContent).toContain('Borrow a long ladder');
        expect(host.textContent).toContain('12.50 Beans');
        expect(host.textContent).toContain('Action needed: release the Beans');
        const release = buttons().find((b) => b.textContent === 'Release 12.50 B')!;
        expect(release).toBeTruthy();
        expect(styleOf(release)).toMatchObject({ flex: 1, backgroundColor: colors.brand.fill });
        const words = release.querySelector('[data-shrinks]')!;
        expect([words.getAttribute('data-lines'), styleOf(words).flexShrink]).toEqual(['1', 1]);
        expect(reading('Cancel')).not.toBeNull();
        expect(host.querySelector('[data-testid="deals-unread"]')).toBeNull();
    });

    it('the chat\'s own community has Beans off, as this phone last heard it: its header names no Beans, whatever the one in use says', async () => {
        store.map.set('beanpool_node_profiles', JSON.stringify({ [RIVER]: { profile: 'local', features: { beans: false }, checkedAt: '2026-11-22T00:00:00.000Z' } }));
        await open([HELD], all(HELD));
        expect(host.textContent).toContain('Borrow a long ladder');
        expect(host.textContent).not.toContain('12.50 Beans');
    });

    it('two to release and one to be paid: a card each, its buttons wrap in the 200 dp card', async () => {
        await open([HELD, EGGS, DUE], all(HELD, EGGS, DUE));
        expect(labelled('Release Beans for Duck eggs')).not.toBeNull();
        expect(labelled('Cancel deal')).not.toBeNull();
        expect(styleOf(labelled('Release Beans for Duck eggs')!.parentElement)).toMatchObject({ flexWrap: 'wrap', flexDirection: 'row' });
        expect(host.textContent).toContain('⏳ Awaiting release');
    });

    it('a standing deal: its panel, readable, with Stop, and no Release or Cancel', async () => {
        await open([STANDING], all(STANDING));
        const panel = host.querySelector('[data-testid="standing-panel-tx-veg"]');
        expect(panel).not.toBeNull();
        expect(host.querySelector('[data-testid="standing-stop"]')).not.toBeNull();
        expect(styleOf(panel!.parentElement)).toMatchObject({ backgroundColor: colors.surface.card, paddingHorizontal: 12 });
        expect(host.textContent).not.toContain('Release');
    });

    it('that community didn\'t answer: says so, in words that wrap and read on their ground, with Try again (44 dp), and no step on any deal', async () => {
        await open([HELD, EGGS, STANDING], null);
        const line = host.querySelector('[data-testid="deals-unread"]')!;
        expect(line.textContent).toContain(`Can't reach ${NAME} right now. Check your connection and try again.`);
        expect(styleOf(line)).toMatchObject({ flexWrap: 'wrap', backgroundColor: colors.surface.card });
        const text = line.querySelector('[data-role="alert"]')!;
        expect(text.getAttribute('data-lines'), 'never cut').toBeNull();
        expect(styleOf(text)).toMatchObject({ flex: 1, minWidth: 160, color: colors.text.secondary });
        expect(contrast(colors.text.secondary, colors.surface.card)).toBeGreaterThanOrEqual(4.5);
        expect(styleOf(reading('Try again')!).minHeight).toBeGreaterThanOrEqual(44);
        for (const label of ['Release Beans for Borrow a long ladder', 'Release Beans for Duck eggs', 'Cancel deal']) expect(labelled(label), label).toBeNull();
        expect(host.querySelector('[data-testid="standing-stop"]')).toBeNull();
        expect(host.textContent).not.toContain('Action needed');
        // Tried again, and answered: the steps are there.
        calls.answer.syncDealsBetween = all(HELD, EGGS, STANDING);
        await press(reading('Try again'), 'Try again');
        expect(host.querySelector('[data-testid="deals-unread"]')).toBeNull();
        expect(labelled('Release Beans for Duck eggs')).not.toBeNull();
        expect(host.querySelector('[data-testid="standing-stop"]')).not.toBeNull();
    });

    it('a request to answer, and a deal that community no longer names: each card says where, and one tap offers the move', async () => {
        await open([ASKED, EGGS], all(ASKED));
        const opens = buttons().filter((b) => b.textContent === `Open ${NAME} ›`);
        expect(opens.length).toBe(2);
        for (const b of opens) expect(b.querySelector('[data-lines]')?.getAttribute('data-lines'), 'two lines in the card').toBe('2');
        expect(host.textContent).toContain('Waiting on you: answer');
        expect(labelled('Release Beans for Duck eggs')).toBeNull();
        await press(opens.find((b) => b.closest('button:not([data-x])')?.parentElement?.textContent?.includes(NAME))!, 'Open');
        expect(lastAlert().title).toBe(NAME);
        expect(lastAlert().body).toBe(`Chainsaw is in ${NAME}. Opens that community.`);
        expect(lastAlert().buttons?.map((b) => b.text)).toEqual(['Cancel', `Open ${NAME} ›`]);
        expect(moved.run).not.toHaveBeenCalled();
        await answerAlert(`Open ${NAME} ›`);
        expect(moved.run.mock.calls.map((c) => c.slice(0, 3))).toEqual([[RIVER, '/post/p-saw?txId=tx-ask', ME.publicKey]]);
        expect(nav.went, 'nothing opens in the community in use').toEqual([]);
    });
});

describe('a step on a deal of a chat in place: asked as at home, then handed the deal\'s own community', () => {
    it('Release on the bar: the home question; nothing until it is answered; then that deal, me, that community, held until it settles', async () => {
        await open([HELD], all(HELD));
        await press(buttons().find((b) => b.textContent === 'Release 12.50 B')!, 'Release');
        expect([lastAlert().title, lastAlert().body]).toEqual(['Release Beans', 'Release 12.50 Beans to the provider? This action cannot be undone.']);
        expect(lastAlert().buttons?.map((b) => [b.text, b.style])).toEqual([['Cancel', 'cancel'], ['Release', 'destructive']]);
        expect(moneyCalls()).toEqual([]);
        const asks = of('syncDealsBetween').length;
        await answerAlert('Release');
        expect(moneyCalls()).toEqual([['completeMarketplaceTransaction', ['tx-held', ME.publicKey, undefined, RIVER]]]);
        expect(of('whileChatInPlace').map((a) => a[0])).toEqual([RIVER]);
        expect(alerts.list.some((a) => a.title === 'Success' && a.body === 'The Beans have been released!')).toBe(true);
        expect(of('syncDealsBetween').length, 'asked that community again').toBeGreaterThan(asks);
        // The review it asks for goes to that community too, and reads nothing of the one in use.
        const dbReads = of('getDb').length;
        await press(reading('Submit Rating'), 'Submit Rating');
        expect(moneyCalls()[1]).toEqual(['submitRating', [ME.publicKey, KOFI, 5, '', 'tx-held', RIVER]]);
        expect(of('whileChatInPlace').map((a) => a[0])).toEqual([RIVER, RIVER]);
        expect(of('getDb').length).toBe(dbReads);
    });

    it('Cancel on the bar, and Release and Cancel on a card: each the home question, then that community', async () => {
        await open([HELD, EGGS], all(HELD, EGGS));
        await press(barCancel(), 'the bar\'s Cancel');
        expect([lastAlert().title, lastAlert().body]).toEqual(['Cancel Hold', 'Are you sure you want to cancel this hold? The Beans held in trust will be refunded.']);
        await answerAlert('Cancel Hold');
        await press(labelled('Release Beans for Duck eggs'), 'the card\'s Release');
        expect(lastAlert().body).toBe('Release 3 Beans to the provider? This action is final.');
        await answerAlert('Release');
        await press(labelled('Cancel deal'), 'the card\'s Cancel');
        expect([lastAlert().title, lastAlert().body]).toEqual(['Cancel Deal', 'Cancel this deal? The Beans held in trust will be refunded.']);
        await answerAlert('Cancel Deal');
        expect(moneyCalls()).toEqual([
            ['cancelMarketplaceTransaction', ['tx-held', ME.publicKey, RIVER]],
            ['completeMarketplaceTransaction', ['tx-eggs', ME.publicKey, undefined, RIVER]],
            ['cancelMarketplaceTransaction', ['tx-eggs', ME.publicKey, RIVER]],
        ]);
        expect(of('whileChatInPlace').map((a) => a[0])).toEqual([RIVER, RIVER, RIVER]);
    });

    it('the question answered No: nothing is asked of anyone', async () => {
        await open([HELD], all(HELD));
        await press(buttons().find((b) => b.textContent === 'Release 12.50 B')!, 'Release');
        await answerAlert('Cancel');
        expect(moneyCalls()).toEqual([]);
    });

    it('Stop on a standing deal: core\'s question, then that standing deal, me, that community, and its word asked again', async () => {
        await open([STANDING], all(STANDING));
        await press(host.querySelector<HTMLElement>('[data-testid="standing-stop"]'), 'Stop');
        expect(moneyCalls()).toEqual([]);
        const asks = of('syncDealsBetween').length;
        await act(async () => { await lastAlert().buttons!.find((b) => b.style === 'destructive')!.onPress!(); });
        await settle();
        expect(moneyCalls()).toEqual([['stopStandingDeal', ['sd-1', ME.publicKey, RIVER]]]);
        expect(of('whileChatInPlace').map((a) => a[0])).toEqual([RIVER]);
        expect(of('syncDealsBetween').length).toBe(asks + 1);
    });

    it('a review from its card goes to that community', async () => {
        await open([DONE], all(DONE));
        await press(labelled('Leave a review for Jam'), 'Review');
        await press(reading('Submit Rating'), 'Submit Rating');
        expect(moneyCalls()).toEqual([['submitRating', [ME.publicKey, KOFI, 5, '', 'tx-done', RIVER]]]);
    });

    it('refused there, or not answered: its words in a dialog, and that community\'s word on the deal asked again', async () => {
        for (const [said, shown] of [
            ['Cannot complete — transaction not found or not authorized', 'Cannot complete — transaction not found or not authorized'],
            ['This phone has switched community since this chat was opened.', 'This phone has switched community since this chat was opened.'],
            ['The account on this phone has changed since this chat was opened. Nothing was sent.', 'The account on this phone has changed since this chat was opened. Nothing was sent.'],
            ['Network request failed. You must be connected to a node.', 'Network request failed. You must be connected to a node.'],
        ]) {
            await act(async () => { root.unmount(); });
            root = createRoot(host);
            calls.list.length = 0;
            await open([HELD], all(HELD), { over: { completeMarketplaceTransaction: () => Promise.reject(new Error(said)) } });
            await press(buttons().find((b) => b.textContent === 'Release 12.50 B')!, 'Release');
            const asks = of('syncDealsBetween').length;
            await answerAlert('Release');
            expect([lastAlert().title, lastAlert().body]).toEqual(['Failed', shown]);
            expect(of('syncDealsBetween').length).toBe(asks + 1);
        }
    });

    it('while a step is on its way its buttons do nothing: a second tap asks nothing', async () => {
        let done!: (v: unknown) => void;
        await open([HELD, EGGS], all(HELD, EGGS), { over: { completeMarketplaceTransaction: () => new Promise((r) => { done = r; }) } });
        await press(labelled('Release Beans for Duck eggs'), 'Release');
        await act(async () => { void lastAlert().buttons!.find((b) => b.text === 'Release')!.onPress!(); });
        await settle(2);
        const asked = alerts.list.length;
        const steps = [labelled('Release Beans for Duck eggs'), labelled('Cancel deal'), reading('Processing...'), barCancel()];
        for (const b of steps) { expect(b?.getAttribute('data-disabled')).toBe('1'); await act(async () => { b!.click(); }); }
        // A card under a step's button opens its listing (the offer), never a step.
        expect(alerts.list.slice(asked).every((a) => a.title === NAME)).toBe(true);
        expect(moneyCalls().length).toBe(1);
        await act(async () => { done({ success: true }); });
        await settle();
    });
});

describe('a step shows only on that community\'s word, from this visit', () => {
    it('before it has answered: the cards, and no step; every ask names it', async () => {
        let answer!: (v: unknown) => void;
        await open([HELD, EGGS], () => new Promise((r) => { answer = r; }));
        expect(host.textContent).toContain('Duck eggs');
        expect(labelled('Release Beans for Duck eggs')).toBeNull();
        expect(host.textContent).not.toContain('Action needed');
        expect(buttons().some((b) => b.textContent === `Open ${NAME} ›`), 'nothing is said to be only there yet').toBe(false);
        expect(of('syncDealsBetween').length).toBe(1);
        await act(async () => { answer(all(HELD, EGGS)); });
        await settle();
        expect(labelled('Release Beans for Duck eggs')).not.toBeNull();
        expect(of('syncDealsBetween').every((a) => a[0] === ME.publicKey && a[1] === KOFI && a[2] === RIVER)).toBe(true);
        expect(of('getDealsBetween').every((a) => a[2] === RIVER)).toBe(true);
    });

    it('left and opened again: its word is asked for again, and no step shows before it comes', async () => {
        await open([HELD, EGGS], all(HELD, EGGS));
        expect(labelled('Release Beans for Duck eggs')).not.toBeNull();
        calls.answer.syncDealsBetween = () => new Promise(() => {});
        const asks = of('syncDealsBetween').length;
        await act(async () => { focus.end?.(); focus.end = null; });
        await settle();
        await act(async () => { focus.end = (focus.cb!() as any) ?? null; });
        await settle();
        expect(of('syncDealsBetween').length).toBe(asks + 1);
        expect(labelled('Release Beans for Duck eggs')).toBeNull();
        expect(host.textContent).not.toContain('Action needed');
    });

    it('left while its answer is on the way: nothing of it is shown or read after', async () => {
        let answer!: (v: unknown) => void;
        await open([HELD], () => new Promise((r) => { answer = r; }));
        await act(async () => { focus.end?.(); focus.end = null; });
        const before = calls.list.length;
        await act(async () => { answer(all(HELD)); });
        await settle();
        expect(calls.list.slice(before).map(([n]) => n)).toEqual([]);
    });

    it('a push, and a deal\'s own line, ask it again; an answer that fails later leaves what it said this visit', async () => {
        await open([HELD], all(HELD));
        const asks = of('syncDealsBetween').length;
        calls.answer.syncDealsBetween = null;
        await act(async () => { for (const fn of events.on[PUSH_RECEIVED_EVENT] ?? []) fn(); });
        await settle();
        expect(of('syncDealsBetween').length).toBe(asks + 1);
        expect(host.textContent).toContain('Action needed');
        expect(host.querySelector('[data-testid="deals-unread"]')).toBeNull();
        calls.answer.getMessages = [{ id: 's1', type: 'system', senderId: 'SYSTEM', systemType: 'ESCROW_RELEASED', text: 'Released.', metadata: {}, rawTimestamp: '2026-11-23T00:00:00.000Z', timestamp: '' }];
        await act(async () => { for (const fn of events.on.sync_data_updated ?? []) fn(); });
        await settle();
        expect(of('syncDealsBetween').length).toBe(asks + 2);
    });

    it('a step wanted while an ask is on its way is followed by one more ask, whose answer is the one kept', async () => {
        const waiting: Array<(v: unknown) => void> = [];
        await open([HELD], () => new Promise((r) => { waiting.push(r); }));
        await act(async () => { for (const fn of events.on[PUSH_RECEIVED_EVENT] ?? []) { fn(); fn(); } });
        await settle();
        expect(waiting.length, 'one at a time').toBe(1);
        await act(async () => { waiting[0](new Map()); });
        await settle();
        expect(waiting.length).toBe(2);
        expect(host.textContent).not.toContain('Action needed');
        await act(async () => { waiting[1](all(HELD)); });
        await settle();
        expect(host.textContent).toContain('Action needed');
        expect(waiting.length).toBe(2);
    });

    it('only a standing deal known with them, and no answer: said too', async () => {
        await open([STANDING], null);
        expect(host.querySelector('[data-testid="deals-unread"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="standing-panel-tx-veg"]')).toBeNull();
    });

    it('one screen per chat and community: no deal of one shows in the next one opened, whatever its own read does', async () => {
        await open([HELD, EGGS], all(HELD, EGGS));
        expect(labelled('Release Beans for Duck eggs')).not.toBeNull();
        calls.answer.getDealsBetween = () => new Promise(() => {});
        calls.answer.syncDealsBetween = () => new Promise(() => {});
        params.now = { id: 'dm1' };
        await act(async () => { root.render(createElement(ChatRoute) as any); });
        await settle();
        expect(host.textContent).toContain('Kofi');
        expect(host.textContent).not.toContain(NAME);
        expect(host.textContent).not.toContain('Duck eggs');
        expect(labelled('Release Beans for Duck eggs')).toBeNull();
    });

    it('one screen per chat and community: from the community in use to the chat in place and back, not one render of its deals there', async () => {
        // The chat in the community in use first, so its route is known when the phone comes back to it.
        await open([], null, { inPlace: false });
        await open([HELD, EGGS], all(HELD, EGGS));
        expect(labelled('Release Beans for Duck eggs')).not.toBeNull();
        calls.answer.getDealsBetween = () => new Promise(() => {});
        calls.answer.syncDealsBetween = () => new Promise(() => {});
        drawn.watch = 'Duck eggs';
        drawn.saw = false;
        try {
            params.now = { id: 'dm1' };
            await act(async () => { root.render(createElement(ChatRoute) as any); });
            await settle();
            expect(host.textContent).toContain('Kofi');
            expect(host.textContent).not.toContain(NAME);
            expect(drawn.saw, 'a deal of that community drawn under the community in use').toBe(false);
        } finally {
            drawn.watch = null;
        }
    });

    it('no deal known with them: nothing is said of one, answered or not', async () => {
        await open([], null);
        expect(host.querySelector('[data-testid="deals-unread"]')).toBeNull();
        expect(host.textContent).not.toContain("Can't reach");
    });

    it('a request on a listing that copy doesn\'t hold: whose it is and its kind are its node\'s word', async () => {
        const need = { ...ASKED, postAuthorPublicKey: null, postType: null, buyerPubkey: ME.publicKey, sellerPubkey: KOFI, iAmBuyer: true };
        await open([need], new Map([[need.txId, { postAuthorPublicKey: ME.publicKey, postType: 'need' }]]));
        expect(host.textContent).toContain('Waiting on you: answer');
    });

    it('a move that didn\'t happen says so; a second tap while it moves does nothing', async () => {
        let done!: (v: string) => void;
        moved.run.mockImplementation(() => new Promise<string>((r) => { done = r; }));
        await open([ASKED], all(ASKED));
        await press(reading(`Open ${NAME} ›`), 'Open');
        const go = lastAlert().buttons![1].onPress!;
        await act(async () => { go(); go(); });
        expect(moved.run).toHaveBeenCalledTimes(1);
        await act(async () => { done('held'); });
        await settle();
        expect([lastAlert().title, lastAlert().body]).toEqual([NAME, 'Something went wrong. Try again in a moment.']);
    });
});

describe('an ordinary chat is as it was', () => {
    it('the same deals: Release and Cancel with no ask of a community, no panel, no move offered, the listing opens', async () => {
        await open([HELD, EGGS, STANDING, ASKED], undefined, { inPlace: false });
        expect(of('syncDealsBetween')).toEqual([]);
        expect(host.querySelector('[data-testid="standing-panel-tx-veg"]')).toBeNull();
        expect(host.textContent).not.toContain(NAME);
        await press(labelled('Release Beans for Duck eggs'), 'Release');
        await answerAlert('Release');
        expect(moneyCalls()).toEqual([['completeMarketplaceTransaction', ['tx-eggs', ME.publicKey, undefined, undefined]]]);
        expect(of('whileChatInPlace').map((a) => a[0])).toEqual([undefined]);
        await press(barCancel(), 'the bar\'s Cancel');
        await answerAlert('Cancel Hold');
        expect(moneyCalls()[1]).toEqual(['cancelMarketplaceTransaction', ['tx-held', ME.publicKey, undefined]]);
        await press(buttons().find((b) => b.textContent?.includes('Chainsaw'))!, 'the card');
        expect(nav.went).toContainEqual({ pathname: '/post/[id]', params: { id: 'p-saw', txId: 'tx-ask' } });
    });
});
