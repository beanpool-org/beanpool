// @vitest-environment jsdom
/**
 * The Credit line tab beside Beans on Send (slice G1; utils/credit-gift.ts; the node's engine/credit-gift.ts;
 * DESIGN-invites-and-names-list-amend2-fable.md §6): app/(tabs)/ledger.tsx rendered for real, with the node client
 * answering as the node would. The tab is there only when the node offers it (the owner's 0 turns it off); its words
 * carry the node's numbers; what it sends is the recipient and the amount and nothing else; every refusal is the node's
 * own sentence, shown as it comes; with Beans locked and part of the line to give, Send opens on the tab. The stand-ins
 * are ledger-words-render.test.ts's, copied (that suite holds the rest of the Ledger's words).
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
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {} },
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

const NODE = 'https://mullum.example';
/** A member who can send Beans: 120 held, a first trade made. */
const HOLDER = {
    balance: 120, floor: -150, usableFloor: -150, liveOffers: 1, activated: true, frozen: false, creditFrozen: false, knownFrozen: false, knownGrant: 0,
    tier: { name: 'Newcomer', emoji: '🌱' }, tierCredit: 3, earnedCredit: 3, qualifiedValue: 10, avgRating: 5, reviewCount: 0, commons: 12.5,
    trustStats: { uniquePartners: 1 },
};
const MEMBERS = [{ publicKey: 'mia-key', callsign: 'Mia' }];
/** The node's refusals a gift can meet (engine/credit-gift.ts), each shown exactly as it comes. */
const REFUSALS = [
    'Giving part of your credit line is off in this community.',
    'A credit-line gift is a whole number of Beans, 1 or more.',
    'You can give up to 100 Beans of your credit line at once here.',
    'You can’t give your credit line to yourself.',
    'Only an active member of this community can be given part of a credit line.',
    'An enterprise can’t be given part of a credit line.',
    'Your credit line is frozen, so you can’t give part of it until an admin unfreezes it.',
    'You can give part of your credit line after your first completed trade, as with sending Beans.',
    'You can only pass on credit line someone gave you, and nobody has given you any. Your known floor and the credit you earned stay yours.',
    'You hold 25 Beans of credit line someone gave you, so you can’t give 50.',
    'You’re using part of your credit line, so you can give 8 Beans of it at most now.',
    'You’re using the credit line someone gave you, so none of it is free to give now.',
    '@Mia can’t be given part of a credit line right now.',
    'This gift would take @Mia’s credit line past the most this community allows (2000 Beans), so it can’t be given.',
];

const node = vi.hoisted(() => ({
    balance: null as any,
    offer: null as any,
    gifts: [] as unknown[][],
    refuse: null as string | null,
    offerReads: 0,
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
    node.offer = { offered: true, max: 100, room: 100, canGive: 100, why: null };
    node.gifts = [];
    node.refuse = null;
    node.offerReads = 0;
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
        if (name === 'signedGet' && args[0] === '/api/credit/gift') {
            node.offerReads++;
            return Promise.resolve(node.offer ? new Response(JSON.stringify(node.offer), { status: 200 }) : new Response('{}', { status: 404 }));
        }
        if (name === 'signedRequest' && args[0] === '/api/credit/gift') {
            node.gifts.push(args);
            return node.refuse ? Promise.reject(new Error(node.refuse)) : Promise.resolve({ amount: (args[1] as any).amount, room: 50, canGive: 50 });
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
const styleOf = (el: Element | null | undefined) => JSON.parse(el?.getAttribute('data-style') || '{}');

async function openSend(label = 'Send Beans') {
    await render();
    await click(byTestId('ledger-wallet-tab'), 'Wallet');
    await click(byLabel(label), label);
}
async function pickMia() {
    await click(Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Select recipient...')), 'Select recipient');
    await click(Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').startsWith('Mia')), 'Mia');
}

describe('the Credit line tab beside Beans on Send (G1)', () => {
    it('no tab when the node does not offer it: the owner set 0, no credit line someone gave them, or a node from before G1', async () => {
        for (const offer of [{ offered: false, max: 0, room: 60, canGive: 0, why: 'Giving part of your credit line is off in this community.' }, { offered: false, max: 100, room: 0, canGive: 0, why: null }, null]) {
            node.offer = offer;
            await openSend();
            expect(byTestId('send-kind-tabs'), JSON.stringify(offer)).toBeNull();
            expect(text()).not.toContain('Credit line');
            expect(byLabel('Amount to send')).not.toBeNull();
            act(() => root.unmount());
            root = createRoot(host);
        }
        expect(node.offerReads).toBeGreaterThan(0);
    });

    it('the tab gives what is typed to whom is picked, and nothing else; the words carry the node\'s number', async () => {
        await openSend();
        expect(byTestId('send-kind-tabs')).not.toBeNull();
        expect(byTestId('send-kind-beans')?.textContent).toBe('Beans');
        await click(byTestId('send-kind-credit'), 'Credit line');
        expect(byTestId('credit-gift-words')?.textContent).toBe('Give part of your credit line. You can give up to 100: the part someone gave you that you aren’t using. It’s theirs for good.');
        await pickMia();
        expect(byTestId('credit-gift-words')?.textContent).toBe('Give @Mia part of your credit line. You can give up to 100: the part someone gave you that you aren’t using. It’s theirs for good.');
        expect(byLabel('Memo')).toBeNull();
        await type(byLabel('Credit line to give'), '50');
        await click(buttonSaying('Give credit line'), 'Give credit line');
        expect(node.gifts).toEqual([['/api/credit/gift', { memberPubkey: 'mia-key', amount: 50 }]]);
        expect(text()).toContain('✓ Given!');
    });

    it('every refusal is the node\'s own sentence, shown as it comes', async () => {
        await openSend();
        await click(byTestId('send-kind-credit'), 'Credit line');
        await pickMia();
        for (const sentence of REFUSALS) {
            node.refuse = sentence;
            await type(byLabel('Credit line to give'), '50');
            await click(buttonSaying('Give credit line'), 'Give credit line');
            expect(text(), sentence).toContain(sentence);
            expect(text()).not.toContain('✓ Given!');
        }
        expect(node.gifts.length).toBe(REFUSALS.length);
    });

    it('nothing to give now: the node\'s why, and Give stays off', async () => {
        node.offer = { offered: true, max: 100, room: 17, canGive: 0, why: 'You’re using the credit line someone gave you, so none of it is free to give now.' };
        await openSend();
        await click(byTestId('send-kind-credit'), 'Credit line');
        await pickMia();
        expect(byTestId('credit-gift-words')?.textContent).toBe('You’re using the credit line someone gave you, so none of it is free to give now.');
        await type(byLabel('Credit line to give'), '5');
        expect(byTestId('send-confirm')?.getAttribute('data-style')).toContain('"backgroundColor"');
        await act(async () => { (buttonSaying('Give credit line') as HTMLElement)?.click(); });
        await settle(4);
        expect(node.gifts).toEqual([]);
    });

    it('Beans locked (nothing held) but part of the line to give: Send opens on the Credit line tab, the Beans tab says why', async () => {
        node.balance = { ...HOLDER, balance: 0 };
        await render();
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        expect(byLabel('Send Beans')).toBeNull();
        await click(byLabel('Give part of your credit line'), 'Give part of your credit line');
        expect(byTestId('credit-gift-words')).not.toBeNull();
        await click(byTestId('send-kind-beans'), 'Beans');
        expect(byTestId('send-beans-locked')?.textContent).toBe('You can only send beans you currently hold — direct sends require a positive balance.');
        expect(buttonSaying('Confirm Transfer')).toBeNull();
    });

    it('Beans locked and nothing to give: Send stays locked as before', async () => {
        node.balance = { ...HOLDER, balance: 0 };
        node.offer = { offered: true, max: 100, room: 50, canGive: 0, why: 'You’re using the credit line someone gave you, so none of it is free to give now.' };
        await render();
        await click(byTestId('ledger-wallet-tab'), 'Wallet');
        expect(text()).toContain('Send Beans (needs positive balance)');
        expect(byLabel('Give part of your credit line')).toBeNull();
    });

    it('at 320 dp with 1.3× text the two tabs share the row and each wraps its words, never cut short', async () => {
        await openSend();
        const tabs = byTestId('send-kind-tabs');
        expect(styleOf(tabs).flexDirection).toBe('row');
        for (const id of ['send-kind-beans', 'send-kind-credit']) {
            const tab = byTestId(id);
            expect(styleOf(tab).flex).toBe(1);
            expect(styleOf(tab).minHeight).toBeGreaterThanOrEqual(44);
            const label = tab?.querySelector('span');
            expect(label?.getAttribute('data-lines')).toBeNull();
            expect(styleOf(label).flexShrink).toBe(1);
        }
        await click(byTestId('send-kind-credit'), 'Credit line');
        expect(byTestId('credit-gift-words')?.getAttribute('data-lines')).toBeNull();
    });
});
