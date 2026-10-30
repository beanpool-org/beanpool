// @vitest-environment jsdom
/**
 * Find a community on a phone with no account (app/find-community.tsx; DESIGN-account-without-global-fable.md §2.4, slice
 * S3), rendered for real as find-community-words-render.test.ts renders it: react-dom in jsdom, React Native's host
 * components as plain tags, the screen's network and storage stubbed at their modules.
 *
 *   - the form: the address box, Scan a code and the line that says how; the list of communities near you (the global
 *     community's directory) is never asked for, nor anything signed by a key the phone doesn't have;
 *   - a typed address is a community to ask; opening its form drafts the key in memory and writes nothing;
 *   - Send writes the key once, with the name typed, hands it to the app, and the knock goes to that address, signed by
 *     that key, naming no community it came from;
 *   - never a second key, with the real utils/knock-key.ts: an account the phone stored after the form opened signs the
 *     knock and the draft is dropped (design §2.1); an account that changes between Send's two reads is refused, said, and
 *     nothing is written or sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled, value, onChangeText, placeholder } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        if (placeholder) attrs.placeholder = placeholder;
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
const nav = vi.hoisted(() => ({ router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('expo-router', () => ({ router: nav.router, useLocalSearchParams: () => ({}), ErrorBoundary: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => undefined) }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
const location = vi.hoisted(() => ({
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'granted', canAskAgain: true })),
    getLastKnownPositionAsync: vi.fn(async () => ({ coords: { latitude: -28.65, longitude: 153.6 } })),
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
    getCurrentPositionAsync: vi.fn(async () => null),
    Accuracy: { Balanced: 3 },
}));
vi.mock('expo-location', () => location);
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
    },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: 'light', colors: lightColors });
    return { useTheme: ctx, useStyles: (factory: (c: ReturnType<typeof ctx>) => unknown) => factory(ctx()) };
});
const who = vi.hoisted(() => ({ identity: null as any, setIdentity: vi.fn() }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
const directory = vi.hoisted(() => ({ fetchCommunities: vi.fn(), fetchGlobalHome: vi.fn() }));
vi.mock('../community-directory', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    fetchCommunities: directory.fetchCommunities,
    fetchGlobalHome: directory.fetchGlobalHome,
    watchPlace: vi.fn(), unwatchPlace: vi.fn(),
}));
const knocks = vi.hoisted(() => ({ sendKnock: vi.fn(), readKnockStatus: vi.fn() }));
vi.mock('../knock', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    sendKnock: knocks.sendKnock,
    readKnockStatus: knocks.readKnockStatus,
}));
const keys = vi.hoisted(() => ({ draft: null as any, knockKeyForThisPhone: vi.fn(), commitKnockKey: vi.fn() }));
vi.mock('../knock-key', () => ({ knockKeyForThisPhone: keys.knockKeyForThisPhone, commitKnockKey: keys.commitKnockKey }));
/**
 * The phone's key store, for the cases that run the real utils/knock-key.ts: what each read of it finds, in order (then
 * `stored`), every key written, and the key a draft makes.
 */
const phoneKey = vi.hoisted(() => ({ reads: [] as any[], stored: null as any, written: [] as any[], draft: null as any }));
vi.mock('../identity', () => ({
    loadIdentity: async () => (phoneKey.reads.length ? phoneKey.reads.shift() : phoneKey.stored),
    importIdentity: async (identity: unknown) => { phoneKey.written.push(identity); },
    draftIdentity: async () => ({ ...phoneKey.draft }),
}));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: vi.fn(), joinedNudge: vi.fn(), PROTECT_REDIRECT: '/x', HOME_REDIRECT: '/y' }));
vi.mock('../typed-place', () => ({
    readTypedPlace: vi.fn(async () => ({ lat: -28.65, lng: 153.6, name: 'Mullumbimby' })), saveTypedPlace: vi.fn(), forgetTypedPlace: vi.fn(async () => undefined),
    nearLine: () => '', LOCATION_NOTES: { off: 'off', failed: 'failed' },
}));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => 'bundled://fox') }));
vi.mock('../node-claim', () => ({ readClaimStatus: vi.fn(async () => ({ kind: 'claimed' })) }));
vi.mock('../notification-permission', () => ({ askNotificationPermissionOnAction: vi.fn(async () => 'unanswered') }));
vi.mock('../../components/AddressSearch', () => ({ AddressSearch: () => null }));

import FindCommunityScreen from '../../app/find-community';
import { KNOCK_MESSAGES } from '../knock';

const RIVERSIDE = 'https://riverside.example.org';
const DRAFT = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: '', createdAt: '2026-10-29T00:00:00.000Z', mnemonic: Array(12).fill('word') };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    store.clear();
    who.identity = null;
    who.setIdentity.mockClear();
    for (const f of [directory.fetchCommunities, directory.fetchGlobalHome, knocks.sendKnock, knocks.readKnockStatus, keys.knockKeyForThisPhone, keys.commitKnockKey,
        location.getForegroundPermissionsAsync, location.getLastKnownPositionAsync, nav.router.push, nav.router.replace]) vi.mocked(f).mockClear();
    directory.fetchCommunities.mockResolvedValue({ ok: true, value: { communities: [], total: 0, fetchedAt: '2026-10-29T00:00:00.000Z' } });
    directory.fetchGlobalHome.mockResolvedValue({ ok: true, value: { watches: [] } });
    knocks.sendKnock.mockResolvedValue({ kind: 'waiting', message: KNOCK_MESSAGES.waiting });
    knocks.readKnockStatus.mockResolvedValue({ ok: true, value: { status: 'pending' } });
    keys.knockKeyForThisPhone.mockImplementation(async (held: any) => held ?? { identity: DRAFT, createdHere: true });
    keys.commitKnockKey.mockImplementation(async (key: any, callsign: string) => ({ ...key.identity, callsign }));
    phoneKey.reads = []; phoneKey.stored = null; phoneKey.written = []; phoneKey.draft = { ...DRAFT };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const buttons = () => Array.from(host.querySelectorAll('button')) as HTMLButtonElement[];
const button = (text: string) => buttons().find((b) => b.textContent === text) ?? null;
async function type(el: HTMLInputElement, value: string) {
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
}

async function render() {
    await act(async () => { root.render(createElement(FindCommunityScreen as any) as any); });
    await settle();
}

describe('Find a community with no account on the phone', () => {
    it('draws the address box, Scan a code and how; asks the directory nothing and reads nothing about where the phone is', async () => {
        await render();
        expect(byId('find-no-account')?.textContent).toBe("Type the community's address, or scan its code. Communities near you show here once you have an account.");
        const box = byId('find-address') as HTMLInputElement;
        expect(box).not.toBeNull();
        expect(box.getAttribute('aria-label')).toBe("The community's address");
        expect(byId('find-scan')?.textContent).toContain('Scan a code');
        // The global community's directory is not read, nor anything signed.
        expect(directory.fetchCommunities).not.toHaveBeenCalled();
        expect(directory.fetchGlobalHome).not.toHaveBeenCalled();
        // Nor where the phone is: there is no list to place.
        expect(location.getForegroundPermissionsAsync).not.toHaveBeenCalled();
        expect(location.getLastKnownPositionAsync).not.toHaveBeenCalled();
        expect(host.textContent).not.toContain('Use my location');
        expect(host.textContent).not.toContain('Tell me when one starts here');
        // Starting a community, or setting up a server, needs no account.
        expect(host.textContent).toContain('Start a community');
        // No key is made by reading the screen.
        expect(keys.knockKeyForThisPhone).not.toHaveBeenCalled();
    });

    it('a word is no address; an address is a community to ask, by its host', async () => {
        await render();
        await type(byId('find-address') as HTMLInputElement, 'riverside');
        expect(byId('find-typed-community')).toBeNull();
        await type(byId('find-address') as HTMLInputElement, 'riverside.example.org');
        const card = byId('find-typed-community');
        expect(card?.textContent).toContain('riverside.example.org');
        expect(card?.querySelector('[aria-label="Ask to join riverside.example.org"]')).not.toBeNull();
        expect(directory.fetchCommunities).not.toHaveBeenCalled();
    });

    it('the form drafts the key in memory and writes nothing; Send writes it once, gives the app the account, and the knock names no community it came from', async () => {
        await render();
        await type(byId('find-address') as HTMLInputElement, 'riverside.example.org');
        await act(async () => { (byId('find-typed-community')!.querySelector('[aria-label="Ask to join riverside.example.org"]') as HTMLElement).click(); });
        await settle();
        expect(keys.knockKeyForThisPhone).toHaveBeenCalledTimes(1);
        expect(keys.commitKnockKey).not.toHaveBeenCalled();
        expect(who.setIdentity).not.toHaveBeenCalled();

        const inputs = Array.from(byId('find-typed-community')!.querySelectorAll('input')) as HTMLInputElement[];
        await type(inputs.find((i) => i.getAttribute('aria-label') === 'Your name')!, 'River Kid');
        await type(inputs.find((i) => i.getAttribute('aria-label') === 'A few words about yourself')!, 'I grow beans by the river.');
        await act(async () => { button('Send')!.click(); });
        await settle();

        expect(keys.commitKnockKey).toHaveBeenCalledTimes(1);
        expect(keys.commitKnockKey.mock.calls[0][0]).toEqual({ identity: DRAFT, createdHere: true });
        expect(keys.commitKnockKey.mock.calls[0][1]).toBe('River Kid');
        expect(who.setIdentity).toHaveBeenCalledWith(expect.objectContaining({ publicKey: DRAFT.publicKey, callsign: 'River Kid' }));
        expect(knocks.sendKnock).toHaveBeenCalledTimes(1);
        const [to, signer, req, fromNode] = knocks.sendKnock.mock.calls[0];
        expect(to).toBe(RIVERSIDE);
        expect(signer.publicKey).toBe(DRAFT.publicKey);
        expect(req).toMatchObject({ callsign: 'River Kid', message: 'I grow beans by the river.', avatar: null });
        expect(fromNode).toBeNull();
        // Remembered, and its answer read from that community only, signed by the knock's key.
        expect(knocks.readKnockStatus).toHaveBeenCalledWith(RIVERSIDE, expect.objectContaining({ publicKey: DRAFT.publicKey }));
    });

    /** The real utils/knock-key.ts behind the screen, over the key store above: nothing of the key's rule is stubbed. */
    async function realKeyRule() {
        const real = await vi.importActual<typeof import('../knock-key')>('../knock-key');
        keys.knockKeyForThisPhone.mockImplementation((held: any) => real.knockKeyForThisPhone(held));
        keys.commitKnockKey.mockImplementation((key: any, callsign: string) => real.commitKnockKey(key, callsign));
    }
    async function openFormAndSend() {
        await render();
        await type(byId('find-address') as HTMLInputElement, 'riverside.example.org');
        await act(async () => { (byId('find-typed-community')!.querySelector('[aria-label="Ask to join riverside.example.org"]') as HTMLElement).click(); });
        await settle();
        const inputs = Array.from(byId('find-typed-community')!.querySelectorAll('input')) as HTMLInputElement[];
        await type(inputs.find((i) => i.getAttribute('aria-label') === 'Your name')!, 'River Kid');
        await type(inputs.find((i) => i.getAttribute('aria-label') === 'A few words about yourself')!, 'Hello.');
        await act(async () => { button('Send')!.click(); });
        await settle();
    }
    const KIM = { publicKey: 'ef'.repeat(32), privateKey: '01'.repeat(32), callsign: 'Kim', createdAt: '2026-10-29T00:00:00.000Z', mnemonic: Array(12).fill('word') };

    it('an account the phone stored after the form opened (an invite join in between) signs the knock: the draft is dropped, nothing is written, never a second key', async () => {
        await realKeyRule();
        // The form opens on a phone with no account: a draft, in memory. By Send, the phone holds Kim's account.
        phoneKey.reads = [null];
        phoneKey.stored = KIM;
        await openFormAndSend();
        expect(phoneKey.written).toEqual([]);
        expect(store.has('beanpool_knock_key')).toBe(false);
        expect(knocks.sendKnock).toHaveBeenCalledTimes(1);
        const [to, signer, req] = knocks.sendKnock.mock.calls[0];
        expect(to).toBe(RIVERSIDE);
        expect(signer.publicKey).toBe(KIM.publicKey);
        expect(req).toMatchObject({ callsign: 'River Kid', message: 'Hello.' });
        // The app is given the phone's account as it is stored: not renamed, and not the draft.
        expect(who.setIdentity).toHaveBeenCalledWith(KIM);
        expect(host.textContent).not.toContain('This phone holds a different BeanPool account');
    });

    it('an account that changes between Send\'s two reads is refused and said: nothing is written, nothing is sent', async () => {
        await realKeyRule();
        const OTHER = { ...KIM, publicKey: '23'.repeat(32), callsign: 'Ash' };
        // The form opens with none; Send reads Kim's account, then, as the key is committed, another.
        phoneKey.reads = [null, KIM, OTHER];
        await openFormAndSend();
        expect(knocks.sendKnock).not.toHaveBeenCalled();
        expect(who.setIdentity).not.toHaveBeenCalled();
        expect(phoneKey.written).toEqual([]);
        expect(host.textContent).toContain('This phone holds a different BeanPool account, so the request was not sent.');
    });
});

describe('with an account, as before', () => {
    it('the list is read, and a typed address the list does not have can be asked too', async () => {
        who.identity = { publicKey: 'ef'.repeat(32), privateKey: '01'.repeat(32), callsign: 'Kim' };
        store.set('beanpool_anchor_url', 'https://global.beanpool.org');
        await render();
        expect(directory.fetchCommunities).toHaveBeenCalled();
        expect(byId('find-no-account')).toBeNull();
        await type(byId('find-address') as HTMLInputElement, 'riverside.example.org');
        expect(byId('find-typed-community')?.querySelector('[aria-label="Ask to join riverside.example.org"]')).not.toBeNull();
    });
});
