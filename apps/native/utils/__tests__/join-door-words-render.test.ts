// @vitest-environment jsdom
/**
 * The join-global screen in the member's language (words slice S3, sweep B4): app/join-open-door.tsx, which Settings →
 * Advanced, the BeanPool sheet and People → Invites open for the global community, and the not-recognised screen for an
 * open-door community of anyone's. Rendered for real inside the real LanguageProvider, with its words module
 * (utils/open-door-words.ts) real; the door's network is stubbed as open-door-screen-render.test.ts stubs it.
 *
 * In the pseudo-locale (`xx`) any text, label or placeholder with letters outside a bracket bypassed t(). Shown as
 * written: a community's own name and address. The two ways in (components/WordsDoor) and the sign-in buttons
 * (components/SsoButton) are shared with the first screen, so they are stand-ins that draw what this screen hands them.
 *
 * The phone's own door sentences are written in global-join.ts, global-join-existing.ts and door-work.ts, which sign the
 * join and hold the key and so stay off the words layer; open-door-words.ts translates them by their exact English. The
 * last block holds that table to those files, sentence by sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, placeholder, value, onChangeText, disabled, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (onPress) attrs.onClick = () => { if (!disabled) onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (placeholder) attrs.placeholder = placeholder;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert() {} },
        BackHandler: { addEventListener: listener },
        AppState: { addEventListener: listener, currentState: 'active' },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const route = vi.hoisted(() => ({ params: {} as Record<string, string | undefined> }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { replace() {}, push() {}, back() {}, canGoBack: () => true },
        useLocalSearchParams: () => route.params,
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        ErrorBoundary: () => null,
    };
});
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'member' }) }));
// Shared with the first screen: stand-ins that draw what this screen hands them.
vi.mock('../../components/SsoButton', () => ({
    GoogleButton: ({ title, onPress }: { title: string; onPress: () => void }) => createElement('button', { onClick: onPress, 'data-sso': 'google' }, title),
    AppleButton: ({ title }: { title: string }) => createElement('button', { 'data-sso': 'apple' }, title),
    FacebookButton: ({ title }: { title: string }) => createElement('button', { 'data-sso': 'facebook' }, title),
}));
vi.mock('../../components/WordsDoor', () => ({
    DoorChoices: ({ onWords, signInNote, wordsProblem }: { onWords: () => void; signInNote: string; wordsProblem: string | null }) => createElement('div', null,
        createElement('button', { onClick: onWords, 'data-testid': 'words-way' }, '⇢'),
        createElement('span', null, signInNote),
        wordsProblem ? createElement('span', { 'data-testid': 'words-problem' }, wordsProblem) : null),
    DoorWorkProgress: () => null,
}));
const KEY = { publicKey: 'ab'.repeat(32), privateKey: 'not-used', callsign: 'Wren' };
vi.mock('../global-join-existing', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../global-join-existing')>()),
    accountKeyForDoor: async () => ({ identity: KEY, createdHere: false }),
}));
vi.mock('../global-join', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../global-join')>()),
    // A sign-in that fails without a reason of its own: the screen's own sentence is shown.
    signInAtDoor: async () => { throw new Error(''); },
}));
const work = vi.hoisted(() => {
    const hook = {
        failed: false,
        start: () => ({}),
        stop() {}, runFor: () => null,
        state: (door: string) => (door === 'words' && hook.failed ? { phase: 'failed' } : null),
        busy: null,
    };
    return { hook };
});
vi.mock('../use-door-work', () => ({ useDoorWork: () => work.hook }));
const lock = vi.hoisted(() => ({ prompts: [] as string[] }));
vi.mock('../LocalAuth', () => ({ authenticateUser: async (prompt: string) => { lock.prompts.push(prompt); return true; } }));
vi.mock('../vault', () => ({ vaultCopyKnown: async () => false }));
vi.mock('../one-way-back', () => ({ startOneWayBack: async () => {} }));
vi.mock('../global-door-offer', () => ({ rememberGlobalDoor: vi.fn() }));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined) }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import JoinOpenDoorScreen from '../../app/join-open-door';
import { DOOR_MESSAGES, nameCheckMessage, type NameCheck } from '../global-join';
import { ACCOUNT_DOOR_MESSAGES, joinedGlobalNotice } from '../global-join-existing';
import { DOOR_WORK_MESSAGES } from '../door-work';
import { GLOBAL_DOOR_MESSAGES } from '../node-profile';
import { doorKeeperWords, doorNameCheckWords, doorRefusalWords, globalPlace, phoneDoorLineWords } from '../open-door-words';

const GLOBAL = 'https://global.beanpool.org';
const SELF = 'https://open.riverbend.example';
const OPEN = { profile: 'global', features: { openJoin: true, wordsDoor: true, door: 'open', invites: false, beans: false } };
const SIGN_IN_ONLY = { profile: 'global', features: { openJoin: true, wordsDoor: false, door: 'open', invites: false, beans: false } };

/** A community's own name and address, shown as written. */
const OTHERS = ['Riverbend Open', 'open.riverbend.example'];

function network(info: Record<string, unknown | null>, names: Record<string, string> = { [SELF]: 'Riverbend Open' }) {
    return vi.fn(async (input: unknown) => {
        const u = String(input);
        for (const [base, body] of Object.entries(info)) {
            if (u === `${base}/api/community/info` && body) return new Response(JSON.stringify(body), { status: 200 });
        }
        for (const [base, name] of Object.entries(names)) {
            if (u === `${base}/api/community/health`) return new Response(JSON.stringify({ nodeName: name }), { status: 200 });
        }
        throw new TypeError(`Network request failed: ${u}`);
    }) as typeof fetch;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    route.params = {};
    work.hook.failed = false;
    lock.prompts.length = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(JoinOpenDoorScreen)) as any); });
    await settle();
}
const button = (english: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(pseudoLocalise(english))) ?? null;
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};

function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const o of OTHERS) rest = rest.split(o).join('');
    return /\p{L}/u.test(rest);
}
function bypassing(): string[] {
    const out = new Set<string>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const whole = n.parentElement?.textContent ?? n.nodeValue;
        if (outsideBrackets(whole)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const [attr, kind] of [['aria-label', 'label'], ['placeholder', 'placeholder']] as const) {
        for (const e of Array.from(host.querySelectorAll(`[${attr}]`))) {
            const v = e.getAttribute(attr);
            if (outsideBrackets(v)) out.add(`${kind}: ${JSON.stringify(v)}`);
        }
    }
    for (const prompt of lock.prompts) if (outsideBrackets(prompt)) out.add(`the phone's lock: ${JSON.stringify(prompt)}`);
    return [...out];
}

describe('the global community\'s door in the pseudo-locale: every word came through t() (words S3e)', () => {
    it('the two ways in, the keeper\'s line, the 12-words way that can\'t run here; then the name step and its refusal', async () => {
        globalThis.fetch = network({ [GLOBAL]: OPEN });
        work.hook.failed = true;
        await renderIn('xx');
        expect(host.querySelector('[role="heading"]')?.textContent).toBe(pseudoLocalise('Global community'));
        expect(host.textContent).toContain(pseudoLocalise('🌍 Join the global community'));
        expect(host.querySelector('[data-testid="words-problem"]')?.textContent).toBe(pseudoLocalise(DOOR_WORK_MESSAGES.solverUnavailable));
        expect(bypassing(), 'choose').toEqual([]);

        await click(host.querySelector('[data-testid="words-way"]'), 'the 12-words way');
        expect(host.textContent).toContain(pseudoLocalise('🔑 With your 12 words: the ones this phone already has. No sign-in needed.'));
        expect(host.textContent).toContain(pseudoLocalise('This is how people there see you. You can change it later.'));
        expect(host.querySelector('input')?.getAttribute('placeholder')).toBe(pseudoLocalise('Your name or nickname'));
        expect(host.textContent).toContain(pseudoLocalise('Join →'));
        expect(host.textContent).toContain(pseudoLocalise('Choose another way'));
        expect(bypassing(), 'name').toEqual([]);
        const input = host.querySelector('input') as HTMLInputElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'W');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click(host.querySelector(`[aria-label="${pseudoLocalise('Join')}"]`), 'Join');
        expect(host.textContent).toContain(pseudoLocalise('Please choose a name of at least {n} characters.').replace('{n}', '2'));
        expect(bypassing(), 'too short').toEqual([]);
    });

    it('a door with the sign-in alone: the keeper\'s line above the buttons, the phone\'s lock, a sign-in that fails', async () => {
        globalThis.fetch = network({ [GLOBAL]: SIGN_IN_ONLY });
        await renderIn('xx');
        expect(host.querySelector('[data-sso="google"]')?.textContent).toBe(pseudoLocalise('Continue with {provider}').replace('{provider}', 'Google'));
        expect(host.querySelector('[data-sso="facebook"]')?.textContent).toBe(pseudoLocalise('Continue with {provider}').replace('{provider}', 'Facebook'));
        expect(bypassing(), 'sign-in').toEqual([]);
        await click(host.querySelector('[data-sso="google"]'), 'Google');
        expect(lock.prompts).toEqual([pseudoLocalise('Confirm authentication to link a sign-in to your account.')]);
        expect(host.textContent).toContain(pseudoLocalise('Sign-in failed. Try again.'));
        expect(bypassing(), 'failed').toEqual([]);
    });

    it('can\'t be reached: the phone\'s own sentence, and Try again', async () => {
        globalThis.fetch = network({ [GLOBAL]: null });
        await renderIn('xx');
        expect(host.textContent).toContain(pseudoLocalise(GLOBAL_DOOR_MESSAGES.unreachable));
        expect(button('Try again')).not.toBeNull();
        expect(bypassing()).toEqual([]);
    });
});

describe('another community\'s door, and an address the screen refuses, in the pseudo-locale', () => {
    it('a community that joins by invite: why, by its own name, under its address', async () => {
        route.params = { node: SELF };
        globalThis.fetch = network({ [SELF]: { profile: 'local', features: { invites: true } } });
        await renderIn('xx');
        expect(host.textContent).toContain('open.riverbend.example');
        expect(host.textContent).toContain(pseudoLocalise("{name} joins people by invite, so it can't be joined here. Ask one of its members for an invite.").replace('{name}', 'Riverbend Open'));
        expect(bypassing()).toEqual([]);
    });

    it('an address it won\'t connect to: says so, and Back', async () => {
        route.params = { node: 'http://open.riverbend.example' };
        globalThis.fetch = network({});
        await renderIn('xx');
        expect(host.textContent).toContain(pseudoLocalise('Join a community'));
        expect(host.textContent).toContain(pseudoLocalise('← Back'));
        expect(bypassing()).toEqual([]);
    });
});

describe('the global door\'s sentences from the files that sign the join: each one through the door\'s words', () => {
    const fromTheKeyFiles = [
        DOOR_MESSAGES.unreachable, DOOR_MESSAGES.doorClosed, DOOR_MESSAGES.accountClosed, DOOR_MESSAGES.removed, DOOR_MESSAGES.keyInvalidated,
        DOOR_MESSAGES.rateLimited, DOOR_MESSAGES.signInRequired, DOOR_MESSAGES.signInAgain, DOOR_MESSAGES.phoneClock, DOOR_MESSAGES.tryAgain,
        DOOR_MESSAGES.signInAnotherWay, ...Object.values(ACCOUNT_DOOR_MESSAGES), DOOR_WORK_MESSAGES.solverUnavailable,
        joinedGlobalNotice(null).title, joinedGlobalNotice(null).body,
    ];

    it('in English each is exactly as those files write it; in the pseudo-locale each is translated', () => {
        for (const line of fromTheKeyFiles) expect(phoneDoorLineWords(line), line).toBe(line);
        setLanguage('xx');
        for (const line of fromTheKeyFiles) expect(phoneDoorLineWords(line), line).toBe(pseudoLocalise(line));
        // A node's own sentence, and one with a time in it, as it came.
        expect(phoneDoorLineWords('This community is full this week.')).toBe('This community is full this week.');
        expect(phoneDoorLineWords(`${DOOR_MESSAGES.rateLimited} (Try again in 5 minutes.)`)).toBe(`${DOOR_MESSAGES.rateLimited} (Try again in 5 minutes.)`);
    });

    it('the global door\'s refusals, name checks and keeper lines: the same English as before, translated', () => {
        const place = globalPlace(GLOBAL);
        const checks: NameCheck[] = [{ kind: 'timed_out' }, { kind: 'taken', suggestions: [], suggestionsTimedOut: true },
            { kind: 'taken', suggestions: ['Wren2'], suggestionsTimedOut: false }, { kind: 'taken', suggestions: [], suggestionsTimedOut: false }];
        for (const check of checks) expect(doorNameCheckWords('Wren', check, place)).toBe(nameCheckMessage('Wren', check));
        setLanguage('xx');
        for (const check of checks) {
            const said = doorNameCheckWords('Wren', check, place);
            expect(said, check.kind).toMatch(/^\[.*\]$/s);
            // The name the member typed is in it as typed (a taken name).
            if (check.kind === 'taken') expect(said).toContain('"Wren"');
        }
        for (const reason of ['unreachable', 'not_global', 'door_closed', 'private_preview'] as const) {
            expect(doorRefusalWords(reason, place), reason).toBe(pseudoLocalise(GLOBAL_DOOR_MESSAGES[reason]));
        }
        for (const copiesAt of ['vault', 'community'] as const) {
            for (const line of Object.values(doorKeeperWords(place, copiesAt))) expect(line, copiesAt).toMatch(/^\[.*\]$/s);
        }
    });
});
