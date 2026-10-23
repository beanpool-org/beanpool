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
 * last block holds that table to those files both ways: each sentence it names is translated, and each fixed sentence
 * the files write is in it or is named with why not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

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
        const s = Object.assign({}, ...[props.style].flat(4).filter((x) => x && typeof x === 'object'));
        if (s.flexDirection === 'row') attrs['data-row'] = 'true';
        if (s.flex !== undefined) attrs['data-flex'] = String(s.flex);
        if (typeof s.flexShrink === 'number' && s.flexShrink > 0) attrs['data-flex-shrink'] = String(s.flexShrink);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
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
import { DOOR_MESSAGES, PRIVATE_PREVIEW_MESSAGE, WORK_MESSAGES, nameCheckMessage, type NameCheck } from '../global-join';
import { ACCOUNT_DOOR_MESSAGES, joinedGlobalNotice } from '../global-join-existing';
import { DOOR_WORK_MESSAGES } from '../door-work';
import { GLOBAL_DOOR_MESSAGES } from '../node-profile';
import { doorKeeperWords, doorNameCheckWords, doorRefusalWords, globalPlace, joinedGlobalBodyWords, phoneDoorLineWords } from '../open-door-words';

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

// ── 320 dp with text at 1.3× (checked with the pseudo-locale) ─────────────────────────────────────────────────────────
const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);
const widestWord = (text: string) => text.split(/[\s\u200B~]+/).reduce((a, b) => (widthOf(b, 1) > widthOf(a, 1) ? b : a), '');
const fontOf = (el: Element): number => { for (let e: Element | null = el; e; e = e.parentElement) { const f = e.getAttribute('data-font'); if (f) return Number(f); } return 14; };

describe('the door at 320 dp with 1.3× text, in the pseudo-locale', () => {
    // 320 - 2 × 16 (the scroll's padding) - 2 × 16 (the card's) - 2 × 1 (its border).
    const CARD = 320 - 32 - 32 - 2;
    const unfit = (): string[] => {
        const out: string[] = [];
        for (const span of Array.from(host.querySelectorAll('span')).filter((s) => /\p{L}/u.test(s.textContent ?? ''))) {
            const word = widestWord(span.textContent ?? '');
            const px = fontOf(span) * SCALE;
            if (widthOf(word, px) > CARD) out.push(`${word} (${Math.round(widthOf(word, px))} > ${CARD})`);
            const row = span.parentElement;
            if (/^\[/.test(span.textContent ?? '') && row?.getAttribute('data-row') === 'true' && row.children.length > 1
                && !span.getAttribute('data-flex') && !span.getAttribute('data-flex-shrink')) out.push(`stuck in a row: ${span.textContent}`);
        }
        return out;
    };

    it('the two ways in, the name step and its buttons: no word wider than the card, nothing stuck in a row', async () => {
        globalThis.fetch = network({ [GLOBAL]: OPEN });
        await renderIn('xx');
        expect(unfit(), 'choose').toEqual([]);
        await click(host.querySelector('[data-testid="words-way"]'), 'the 12-words way');
        expect(host.textContent).toContain(pseudoLocalise('Choose another way'));
        expect(unfit(), 'name').toEqual([]);
    });

    it('the sign-in door and a refusal: the same', async () => {
        globalThis.fetch = network({ [GLOBAL]: SIGN_IN_ONLY });
        await renderIn('xx');
        expect(unfit(), 'sign-in').toEqual([]);
        act(() => root.unmount());
        root = createRoot(host);
        globalThis.fetch = network({ [GLOBAL]: null });
        await renderIn('xx');
        expect(unfit(), 'unreachable').toEqual([]);
    });
});

describe('the global door\'s sentences from the files that sign the join: each one through the door\'s words', () => {
    const fromTheKeyFiles = [
        DOOR_MESSAGES.unreachable, DOOR_MESSAGES.doorClosed, DOOR_MESSAGES.accountClosed, DOOR_MESSAGES.removed, DOOR_MESSAGES.keyInvalidated,
        DOOR_MESSAGES.rateLimited, DOOR_MESSAGES.signInRequired, DOOR_MESSAGES.signInAgain, DOOR_MESSAGES.phoneClock, DOOR_MESSAGES.tryAgain,
        DOOR_MESSAGES.signInAnotherWay, ...Object.values(WORK_MESSAGES), PRIVATE_PREVIEW_MESSAGE,
        ...Object.values(ACCOUNT_DOOR_MESSAGES), DOOR_WORK_MESSAGES.solverUnavailable,
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

    it('and every fixed sentence those files write is in the table, or named here with why it is not', () => {
        // Each plain string that reads as a sentence, two joined with + read as one. A template has a time or a name in it.
        const written = ['global-join.ts', 'global-join-existing.ts', 'door-work.ts'].flatMap((file) => {
            const sf = ts.createSourceFile(file, fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), ts.ScriptTarget.Latest, true);
            const text = (node: ts.Node): string | null => {
                if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
                if (ts.isParenthesizedExpression(node)) return text(node.expression);
                if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
                    const left = text(node.left);
                    const right = text(node.right);
                    return left !== null && right !== null ? left + right : null;
                }
                return null;
            };
            const out: string[] = [];
            const visit = (node: ts.Node) => {
                const said = text(node);
                if (said === null) ts.forEachChild(node, visit);
                else if (/^[A-Z].* .*[.…]$/s.test(said)) out.push(said);
            };
            visit(sf);
            return out;
        });
        expect(written.length).toBeGreaterThan(20);
        const elsewhere: Record<string, string> = {
            [DOOR_MESSAGES.alreadyJoined]: "the first screen's: this door says ACCOUNT_DOOR_MESSAGES.otherAccount instead",
            [nameCheckMessage('Wren', { kind: 'timed_out' })]: 'doorNameCheckWords says it (the next test)',
            [DOOR_WORK_MESSAGES.settingUp]: "components/WordsDoor's, with the first screen's sweep",
            "That sign-in did not say who you are, so it can't be used. Try again.": "providerSignIn's exception, shown as it came",
            'This phone holds a different BeanPool account, so the join was not sent.': "commitJoinKey's: the first screen's join, never this door's",
            'This phone holds a different BeanPool account, so the join was not saved here.': "keepJoinedIdentity's: the first screen's join, never this door's",
        };
        setLanguage('xx');
        expect(written.filter((line) => phoneDoorLineWords(line) === line && !(line in elsewhere))).toEqual([]);
        // Nothing named here is gone from the files.
        for (const line of Object.keys(elsewhere)) expect(written, elsewhere[line]).toContain(line);
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

describe('"You\'re in" after a sign-in was linked: each paragraph of joinedGlobalNotice through the door\'s words', () => {
    const linked = { enrolledSso: ['google'], replaced: true } as unknown as Parameters<typeof joinedGlobalNotice>[0];
    const CAME = 'Your key and your 12 words are the same as before, and nothing changed in your other communities: your posts, chats and trades stay in each one.';
    const PT = {
        [CAME]: 'A sua chave e as suas 12 palavras são as mesmas de antes, e nada mudou nas suas outras comunidades: as suas publicações, conversas e trocas ficam em cada uma.',
        'Your {name} sign-in is now also a way back into your account, in every community.': 'O seu início de sessão {name} agora também é um caminho de volta à sua conta, em todas as comunidades.',
        'Your {name} sign-in is now also a way back into your account here.': 'O seu início de sessão {name} agora também é um caminho de volta à sua conta aqui.',
        'This {provider} account used to protect a different BeanPool account. It protects this one now, and that one has only its 12 words.': 'Esta conta {provider} protegia outra conta BeanPool. Agora protege esta, e a outra tem só as suas 12 palavras.',
    };

    it('in English exactly as global-join-existing.ts writes it, in Portuguese where the words have it, the sign-in\'s name as written', () => {
        const { body } = joinedGlobalNotice(linked);
        const paragraphs = body.split('\n\n');
        expect(paragraphs).toHaveLength(3);
        expect(joinedGlobalBodyWords(body)).toBe(body);
        setLanguage('pt', [PT]);
        const pt = joinedGlobalBodyWords(body).split('\n\n');
        expect(pt[0]).toBe(PT[CAME]);
        expect(pt[1]).toMatch(/^O seu início de sessão Google agora também é um caminho de volta à sua conta/);
        expect(pt[2]).toBe('Esta conta Google protegia outra conta BeanPool. Agora protege esta, e a outra tem só as suas 12 palavras.');
        setLanguage('xx');
        for (const p of joinedGlobalBodyWords(body).split('\n\n')) expect(p).toMatch(/^\[.*\]$/s);
    });

    it('both ways a sign-in comes back are read, and a paragraph it can\'t read is shown as given', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../global-join-existing.ts'), 'utf8');
        const everywhere = 'Your ${name} sign-in is now also a way back into your account, in every community.';
        const here = 'Your ${name} sign-in is now also a way back into your account here.';
        expect(source).toContain(everywhere);
        expect(source).toContain(here);
        setLanguage('pt', [PT]);
        expect(joinedGlobalBodyWords(everywhere.replace('${name}', 'Apple'))).toBe('O seu início de sessão Apple agora também é um caminho de volta à sua conta, em todas as comunidades.');
        expect(joinedGlobalBodyWords(here.replace('${name}', 'Apple'))).toBe('O seu início de sessão Apple agora também é um caminho de volta à sua conta aqui.');
        expect(joinedGlobalBodyWords('Riverbend is closed for the winter.')).toBe('Riverbend is closed for the winter.');
    });
});
