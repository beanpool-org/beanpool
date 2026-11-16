// @vitest-environment jsdom
/**
 * The Ledger's half of Learn's "🫘 Thank {name}" (slice K8; DESIGN-local-knowledge-fable.md §3.7): app/(tabs)/ledger.tsx
 * rendered for real, opened by the Learn page with a recipient and a note (route params sendTo, sendName, sendNote). One table
 * over the reader (can send, first trade required, positive balance required, the recipient being themselves) -> the Beans form
 * with the writer chosen and the note filled / today's words in today's alert and no form / nothing. Then the form honours both
 * and changes nothing else: each is changeable, what is sent is what the form shows, the request is taken once, and Send opened
 * by its own button is as before (ledger-credit-gift.test.ts and ledger-words-render.test.ts stay as they are). The stand-ins are
 * ledger-credit-gift.test.ts's, copied, with the route's params and setParams added.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(6).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        const s = flat(props.style);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        attrs['data-style'] = JSON.stringify(s);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
            ListHeaderComponent,
            data.length
                ? data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item, index })))
                : ListEmptyComponent),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), TouchableWithoutFeedback: el('button'), SafeAreaView: el('div'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                for (const b of buttons ?? []) { if (b.text) alerts.said.push(b.text); alerts.buttons.push(b); }
            },
        },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
// The route's params as the Learn page pushed them; setParams clears them as the Ledger takes the request, as expo-router does.
const route = vi.hoisted(() => ({ params: {} as Record<string, string>, cleared: [] as Array<Record<string, string>>, rerender: null as null | (() => void) }));
vi.mock('expo-router', async () => {
    const { useEffect: effect, useState } = await import('react');
    return {
        router: {
            push() {}, navigate() {}, replace() {}, back() {},
            setParams: (p: Record<string, string>) => { route.cleared.push(p); route.params = { ...route.params, ...p }; route.rerender?.(); },
        },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => {
            const [, bump] = useState(0);
            route.rerender = () => bump((n: number) => n + 1);
            return route.params;
        },
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
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', EncodingType: { UTF8: 'utf8' }, writeAsStringAsync: async () => {} }));
vi.mock('expo-sharing', () => ({ shareAsync: async () => {} }));
vi.mock('../haptics', () => ({ hapticSuccess() {}, hapticWarning() {} }));
const blocked = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => blocked.keys, BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
// One identity object for the whole run, as the app's context keeps it: a new one each render would reload the tab forever.
const me = vi.hoisted(() => ({ identity: { publicKey: 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12', callsign: 'Ana' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => me }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}),
    signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));

// Shared with other screens, or with words that live elsewhere: drawn as stand-ins (see the note above).
vi.mock('../../components/CreditBar', () => ({ CreditBar: () => createElement('span', { 'data-later-sweep': 'CreditBar' }) }));
vi.mock('../../components/RepaymentCard', () => ({ RepaymentCard: () => createElement('span', { 'data-later-sweep': 'RepaymentCard' }) }));
vi.mock('../../components/CommonsInfoModal', () => ({ CommonsInfoModal: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({
    LocalCommunityMark: ({ label }: { label?: string }) => createElement('button', { 'data-later-sweep': 'LocalCommunityMark' }, label ?? null),
    LocalCommunitySheet: () => null,
    ExampleHeader: () => null,
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/TrustBadge', () => ({ TrustBadge: ({ level }: { level: string }) => createElement('span', { 'data-badge': level }) }));

import { setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import LedgerScreen from '../../app/(tabs)/ledger';

const NODE = 'https://riverside.example';
/** A member who can send Beans: 120 held, a first trade made. Whole hundredths of a Bean, as getBalance answers (db.ts). */
const HOLDER = {
    balance_c: 12000, floor_c: -15000, usableFloor_c: -15000, liveOffers: 1, activated: true, frozen: false, creditFrozen: false, knownFrozen: false, knownGrant_c: 0,
    tier: { name: 'Newcomer', emoji: '🌱' }, tierCredit_c: 300, earnedCredit_c: 300, qualifiedValue_c: 1000, avgRating: 5, reviewCount: 0, commons_c: 1250,
    trustStats: { uniquePartners: 1 },
};
// Ada, whom the page thanks, is not in the list this phone holds: her name comes with the request.
const MEMBERS = [{ publicKey: 'mia-key', callsign: 'Mia' }];
const node = vi.hoisted(() => ({
    balance: null as any,
    offer: null as any,
    gifts: [] as unknown[][],
    refuse: null as string | null,
    offerReads: 0,
    sends: [] as unknown[][],
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    net.calls.length = 0;
    blocked.keys = [];
    node.balance = HOLDER;
    // The node's figures are whole hundredths (engine/credit-gift.ts creditGiftOffer: `max`, `room`, `canGive` kept their names).
    node.offer = { offered: true, max: 10000, room: 10000, canGive: 10000, why: null };
    node.gifts = [];
    node.refuse = null;
    node.offerReads = 0;
    node.sends = [];
    route.params = {};
    route.cleared = [];
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features: { beans: true, showcase: false }, checkedAt: new Date().toISOString() } }));
    net.answer = (name, args) => {
        if (name === 'getBalance') return Promise.resolve(node.balance);
        if (name === 'getTransactions') return Promise.resolve([]);
        if (name === 'getMemberProfile') return Promise.resolve({ avatar_url: null });
        if (name === 'getAllCommunityMembers') return Promise.resolve(MEMBERS);
        if (name === 'getEscrowTotal') return Promise.resolve(0);
        if (name === 'getPledgeHistory') return Promise.resolve([]);
        if (name === 'refreshBalanceFromServer') return Promise.resolve(null);
        if (name === 'sendTransfer') { node.sends.push(args); return Promise.resolve({}); }
        if (name === 'signedGet' && args[0] === '/api/credit/gift') {
            node.offerReads++;
            return Promise.resolve(node.offer ? new Response(JSON.stringify(node.offer), { status: 200 }) : new Response('{}', { status: 404 }));
        }
        if (name === 'signedRequest' && args[0] === '/api/credit/gift') {
            node.gifts.push(args);
            return node.refuse ? Promise.reject(new Error(node.refuse)) : Promise.resolve({ amount: (args[1] as any).amount_c, room: 5000, canGive: 5000 });
        }
        return undefined;
    };
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const realSetTimeout = setTimeout;
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => realSetTimeout(r, 0)); }); };
async function render(lang: UiLang = 'en') {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(LedgerScreen)) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
};
const type = async (el: Element | null | undefined, value: string) => {
    expect(el).toBeTruthy();
    const input = el as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const byLabel = (label: string) => host.querySelector(`[aria-label="${label.replace(/"/g, '\\"')}"]`);
const buttonSaying = (words: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === words) ?? null;
const text = () => host.textContent ?? '';
const ADA = 'ada'.padEnd(64, '0');
const NOTE = 'Thanks for "How recycling works at the tip"';
const THANK = { sendTo: ADA, sendName: 'Ada', sendNote: NOTE };
const FIGURES = {
    'can send': { balance_c: 12000, earnedCredit_c: 300 },
    'first trade required': { balance_c: 12000, earnedCredit_c: 0 },
    'positive balance required': { balance_c: 0, earnedCredit_c: 300 },
} as const;
type Reader = keyof typeof FIGURES;
const recipient = () => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Ada') || (b.textContent ?? '').includes('Select recipient...')) ?? null;
const confirm = () => buttonSaying('Confirm Transfer') ?? Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Confirm')) ?? null;

describe('Send opened by Learn\'s Thank (K8)', () => {
    const TABLE: Array<[Reader, 'form' | 'first-trade' | 'positive-balance']> = [
        ['can send', 'form'],
        ['first trade required', 'first-trade'],
        ['positive balance required', 'positive-balance'],
    ];
    it.each(TABLE)('%s -> %s (red when the request is dropped, the gate is skipped, or new words replace today\'s)', async (reader, outcome) => {
        node.balance = { ...HOLDER, ...FIGURES[reader] };
        route.params = { ...THANK };
        await render();
        // Taken once, as the member's figures were read: the route's request is cleared.
        expect(route.cleared).toEqual([{ sendTo: '', sendName: '', sendNote: '' }]);
        if (outcome === 'form') {
            expect(recipient()?.textContent).toContain('Ada');
            expect((byLabel('Memo') as HTMLInputElement | null)?.value).toBe(NOTE);
            expect((byLabel('Amount to send') as HTMLInputElement | null)?.value).toBe('');
            expect(alerts.said).toEqual([]);
        } else {
            // Today's alert, word for word, and no form.
            expect(alerts.said).toEqual(outcome === 'first-trade'
                ? ['First trade required', 'Direct sends are unlocked after your first completed trade on the Marketplace, and require a positive balance.', 'OK']
                : ['Positive balance required', 'You can only send beans you currently hold — direct sends require a positive balance.', 'OK']);
            expect(byLabel('Memo')).toBeNull();
            expect(byLabel('Amount to send')).toBeNull();
        }
        expect(node.sends).toEqual([]);
    });

    it('the recipient being the member themselves: no form and no alert (Learn shows no button for one\'s own page; this is the guard behind it)', async () => {
        route.params = { ...THANK, sendTo: me.identity.publicKey, sendName: 'Ana' };
        await render();
        expect(route.cleared.length).toBe(1);
        expect(byLabel('Memo')).toBeNull();
        expect(alerts.said).toEqual([]);
    });

    it('sends what the form shows: the writer and the note as filled in, the typed amount, through the ordinary send', async () => {
        route.params = { ...THANK };
        await render();
        await type(byLabel('Amount to send'), '5');
        await click(confirm(), 'Confirm');
        expect(node.sends).toEqual([[me.identity.publicKey, ADA, 500, NOTE]]);
    });

    it('both are changeable: another note, another recipient from the picker, and that is what is sent', async () => {
        route.params = { ...THANK };
        await render();
        await type(byLabel('Memo'), 'Ta!');
        await click(recipient(), 'the recipient row');
        await click(Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').startsWith('Mia')), 'Mia');
        await type(byLabel('Amount to send'), '2');
        await click(confirm(), 'Confirm');
        expect(node.sends).toEqual([[me.identity.publicKey, 'mia-key', 200, 'Ta!']]);
    });

    it('figures not on this phone yet (lineKnown false): no refusal from zeros, the request waits; real figures open the form', async () => {
        // A member who can send, but whose phone holds none of the node's figures yet: zeros, and the node asked (refresh).
        node.balance = { balance_c: 0, earnedCredit_c: 0, lineKnown: false, tier: { name: 'Newcomer', emoji: '🌱' } };
        route.params = { ...THANK };
        await render();
        expect(alerts.said).toEqual([]);
        expect(route.cleared).toEqual([]);
        expect(byLabel('Memo')).toBeNull();
        // The node's figures land (the sync reloads the screen): the request is taken now, with the real gate.
        node.balance = HOLDER;
        await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(LedgerScreen)) as any); });
        act(() => root.unmount());
        root = createRoot(host);
        await render();
        expect(route.cleared).toEqual([{ sendTo: '', sendName: '', sendNote: '' }]);
        expect((byLabel('Memo') as HTMLInputElement | null)?.value).toBe(NOTE);
        expect(alerts.said).toEqual([]);
    });

    it('with no request, the Ledger opens as before: nothing cleared, no form, no alert', async () => {
        await render();
        expect(route.cleared).toEqual([]);
        expect(byLabel('Memo')).toBeNull();
        expect(text()).toContain('Ledger');
        expect(alerts.said).toEqual([]);
    });
});
