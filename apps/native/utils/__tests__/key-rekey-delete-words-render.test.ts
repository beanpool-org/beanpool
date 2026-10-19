// @vitest-environment jsdom
/**
 * A re-key code (app/rekey-code.tsx) and deleting the account from the not-recognised screen (app/node-mismatch.tsx) in
 * the member's language (words S3, sweep B10), rendered for real inside the real LanguageProvider with React Native's
 * host components as plain tags (key-words-harness.ts). The re-key's steps (utils/rekey-redeem.ts: the key written down
 * before anything is sent, the node's answers) and the delete's (the other communities asked, the phone's lock, the
 * words read back behind it) are stubbed at the screens' own imports; nothing is contacted.
 *
 * In the pseudo-locale any text, label, hint, placeholder or alert with letters outside a bracket bypassed t(). Shown as
 * written: communities' names and addresses, the re-key code and its pattern, the number, and the 12 words (read back
 * behind the phone's lock and shown as they are: never looked up).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock('react-native', async () => (await import('./key-words-harness')).nativeMock(alerts));
const nav = vi.hoisted(() => ({ params: {} as Record<string, string | undefined> }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    const r = { replace() {}, push() {}, back() {}, canGoBack: () => true, navigate() {} };
    return {
        router: r, useRouter: () => r,
        useLocalSearchParams: () => nav.params,
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        ErrorBoundary: () => null,
    };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })] }));
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return { useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children?: unknown }) => h('div', null, children as any) };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    const pass = ({ children }: { children?: unknown }) => h('div', null, children as any);
    return { KeyboardAwareScrollView: pass, KeyboardAvoidingView: pass };
});
vi.mock('@expo/vector-icons', async () => {
    const { createElement: h } = await import('react');
    return { MaterialCommunityIcons: ({ name }: { name: string }) => h('i', { 'data-icon': name }) };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx), useOnboardingColors: () => ({ colors: lightColors, dark: false }) };
});
const who = vi.hoisted(() => ({ identity: { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Sally' }, setIdentity() {} }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('expo-clipboard', () => ({ getStringAsync: async () => '' }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)) };
});
vi.mock('../db', () => ({ closeDB: async () => {}, initDB: async () => {} }));
vi.mock('../community-switch', () => ({ communitySwitched: () => {} }));
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {} }));

// ── A re-key: what the node answers, by the test ─────────────────────────────────────────────────────────────────
const rekey = vi.hoisted(() => ({ begin: null as null | (() => Promise<unknown>), answer: null as any }));
vi.mock('../rekey-redeem', async (importOriginal) => {
    const real = await importOriginal<typeof import('../rekey-redeem')>();
    return {
        ...real,
        resumeRekey: async () => null,
        beginRekey: async () => (rekey.begin ? rekey.begin() : { community: 'https://mullum.example', code: 'RK-AB12-CD34', publicKey: 'k', madeHere: true, startedAt: Date.now() }),
        askRekey: async () => rekey.answer,
        pollRekey: async () => ({ state: 'waiting', match: '42', expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString() }),
        abandonRekey: async () => {},
    };
});

// ── The not-recognised screen: a stranger at a local community, with the delete at the end ──────────────────────────
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recognition: 'stranger', nodeUrl: 'https://riverside.example', recheck: async () => 'unknown' }) }));
const wipe = vi.hoisted(() => ({ keeping: [] as unknown[], words: null as string[] | null }));
vi.mock('../words-behind-lock', () => ({ readWordsBehindLock: async () => wipe.words }));
vi.mock('../words-put-away', () => ({ usePutAwayAfterLeave: () => {} }));
vi.mock('../LocalAuth', () => ({ authenticateUser: async () => true }));
vi.mock('../account-leaves-phone', () => ({ deleteAccountFromThisPhone: async () => {}, signOutOfThisPhone: async () => {} }));
vi.mock('../identity', () => ({
    hasMnemonic: () => true, loadIdentity: async () => null, draftIdentity: async () => null, importIdentity: async () => {},
    getMnemonic: async () => null, StoredKeyUnreadableError: class extends Error {},
}));
vi.mock('../delete-here', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../delete-here')>()),
    otherCommunitiesKeeping: async () => wipe.keeping,
}));
vi.mock('../global-join-existing', () => ({
    isGlobalCommunity: (url: string | null | undefined) => !!url && url.includes('global.beanpool.org'),
    accountClosedAtGlobal: async () => false, rememberAccountClosed: async () => {}, forgetAccountClosed: async () => {},
}));
vi.mock('../join-another-community', () => ({
    joinAnotherCommunity: async () => { throw new Error('not here'); }, joinedNudge: () => ({ title: '', body: '', later: '' }), PROTECT_REDIRECT: '/', HOME_REDIRECT: '/',
}));
vi.mock('../../components/NoWordsNotice', () => ({ NoWordsNotice: () => null }));
vi.mock('../../components/WordsOnScreen', async () => {
    const { createElement: h } = await import('react');
    return { NoScreenCapture: ({ children }: { children?: unknown }) => h('div', null, children as any), NoScreenLockNote: () => null };
});

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import RekeyCodeScreen from '../../app/rekey-code';
import NodeMismatchScreen from '../../app/node-mismatch';
import { REKEY_TEXT, RekeyHeldError } from '../rekey-redeem';
import { NO_OTHER_COMMUNITY_LINE } from '../delete-here';
import { bypassing, unfit } from './key-words-harness';

const TWELVE = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const WRITTEN = ['mullum.example', 'https://mullum.example', 'RK-AB12-CD34', 'RK-XXXX-XXXX', '42', 'riverside.example', 'https://riverside.example', 'Mullum',
    'Riverside', 'Castlemaine', 'node.yourcommunity.org', ...TWELVE];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    nav.params = {};
    store.map.clear();
    rekey.begin = null;
    wipe.keeping = [];
    wipe.words = null;
    globalThis.fetch = (async (input: unknown) => { throw new TypeError(`Network request failed: ${String(input)}`); }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async () => { for (let i = 0; i < 14; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, Screen: () => unknown) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(Screen as any)) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
const buttonWith = (english: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(pseudoLocalise(english))) ?? null;
async function type(into: Element | null, value: string) {
    expect(into, 'the field').toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(into, value);
        into!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
}
const clean = () => bypassing(host, WRITTEN, alerts.said);

describe('a re-key code in the pseudo-locale', () => {
    it('the form, in capitals by the language\'s rule; an address it can\'t use', async () => {
        await renderIn('xx', RekeyCodeScreen);
        expect(host.textContent).toContain(pseudoLocalise('Re-key code').toLocaleUpperCase());
        expect(host.querySelector('[data-transform]')).toBeNull();
        expect(clean()).toEqual([]);
        await click(buttonWith('Continue'), 'Continue');
        expect(host.textContent).toContain(pseudoLocalise('Type your community’s name or address, as your admin gave it.'));
        expect(clean()).toEqual([]);
        // 320 - 2 × 16.
        expect(unfit(host, 320 - 32, WRITTEN)).toEqual([]);
    });

    it('the number for the admin, from the community it came from, and the time left', async () => {
        rekey.answer = { state: 'waiting', match: '42', expiresAt: new Date(Date.now() + 3 * 3600_000 + 5 * 60_000).toISOString() };
        await renderIn('xx', RekeyCodeScreen);
        await type(host.querySelectorAll('input')[0], 'mullum.example');
        await type(host.querySelectorAll('input')[1], 'RK-AB12-CD34');
        await click(buttonWith('Continue'), 'Continue');
        expect(host.textContent).toContain(pseudoLocalise('Show this number to your admin'));
        expect(host.querySelector('[data-testid="rekey-number-host"]')?.textContent).toBe(pseudoLocalise('from {host}').replace('{host}', 'mullum.example'));
        expect(clean()).toEqual([]);
        expect(unfit(host, 320 - 32 - 32, WRITTEN)).toEqual([]);
    });

    it('a refusal the node gave in the phone\'s words, and an earlier re-key still held', async () => {
        rekey.answer = { state: 'gone' };
        await renderIn('xx', RekeyCodeScreen);
        await type(host.querySelectorAll('input')[0], 'mullum.example');
        await type(host.querySelectorAll('input')[1], 'RK-AB12-CD34');
        await click(buttonWith('Continue'), 'Continue');
        expect(host.textContent).toContain(pseudoLocalise(REKEY_TEXT.gone));
        expect(clean()).toEqual([]);
        rekey.begin = async () => { throw new RekeyHeldError('This phone showed a number for a re-key at mullum.example, and mullum.example isn’t answering. Try again later, or forget that re-key.', 'mullum.example', true); };
        await click(buttonWith('Try again'), 'Try again');
        expect(host.textContent).toContain(pseudoLocalise('This phone showed a number for a re-key at {where}, and {where} isn’t answering. Try again later, or forget that re-key.').split('{where}').join('mullum.example'));
        const forget = pseudoLocalise('Forget the re-key at {host}').replace('{host}', 'mullum.example');
        await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === forget), 'Forget the re-key at mullum.example');
        expect(alerts.said[0]).toBe(pseudoLocalise('Forget the re-key at {host}?').replace('{host}', 'mullum.example'));
        expect(clean()).toEqual([]);
    });
});

describe('deleting the account from the not-recognised screen, in the pseudo-locale', () => {
    it('the words first, behind the phone\'s lock, then the question', async () => {
        wipe.words = TWELVE;
        await renderIn('xx', NodeMismatchScreen);
        await click(buttonWith('Delete this account from this phone'), 'Delete');
        expect(host.textContent).toContain(pseudoLocalise('Write these 12 words down first'));
        for (const w of TWELVE) expect(host.textContent).toContain(w);
        expect(clean()).toEqual([]);
        await click(buttonWith("I've saved them — delete the account"), 'Delete the account');
        expect(alerts.said[0]).toBe(pseudoLocalise('Delete this account from this phone?'));
        expect(alerts.said[1]).toContain(pseudoLocalise(NO_OTHER_COMMUNITY_LINE));
        expect(clean()).toEqual([]);
        expect(unfit(host, 320 - 48 - 48, WRITTEN)).toEqual([]);
    });

    it('another saved community keeps the key: why, and where to switch', async () => {
        wipe.keeping = [{ url: 'https://mullum.example', name: 'Mullum', membership: 'member' }, { url: 'https://castlemaine.example', name: 'Castlemaine', membership: 'unreachable' }];
        await renderIn('xx', NodeMismatchScreen);
        await click(buttonWith('Delete this account from this phone'), 'Delete');
        expect(host.textContent).toContain('Mullum');
        expect(host.textContent).toContain(pseudoLocalise('Deleting this account from this phone would lose it there too, so this phone keeps it.'));
        expect(bypassing(host, [...WRITTEN, 'castlemaine.example', 'mullum.example'], alerts.said)).toEqual([]);
    });
});
