// @vitest-environment jsdom
/**
 * The key path's shared pieces in the member's language (words S3, sweep B10): "Add a sign-in as a second way back"
 * (components/LinkSignInSheet.tsx), the node's 2FA code (TotpCodeDialog), the 12 boxes (RecoveryWordsEntry), the global
 * door's two ways in and Safety Backup's note (WordsDoor), "Add your 12 words to this phone" (AddWordsForm) and App
 * Lock's screen (AppLock). Each is rendered for real inside the real LanguageProvider, React Native's host components as
 * plain tags (key-words-harness.ts); the sign-in, the phone's lock and the save of the words are stubbed.
 *
 * In the pseudo-locale any text, label, hint, placeholder or alert with letters outside a bracket bypassed t(). Shown as
 * written: the sign-in providers' names, a community's name, and the 12 words a member types (never looked up).
 *
 * join-link.ts and add-words.ts sign the link and hold the 12 words, so they stay off the words layer: their sentences
 * are translated in the components, and the last block holds those to the files, sentence by sentence, in English.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock('react-native', async () => (await import('./key-words-harness')).nativeMock(alerts));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    const pass = ({ children }: { children?: unknown }) => h('div', null, children as any);
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass };
});
const clip = vi.hoisted(() => ({ text: '' }));
vi.mock('expo-clipboard', () => ({ getStringAsync: async () => clip.text }));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('../../components/WordsOnScreen', async () => {
    const { createElement: h } = await import('react');
    return { NoScreenCapture: ({ children }: { children?: unknown }) => h('div', null, children as any), NoScreenLockNote: () => null };
});
// The provider buttons are shared with the first screen: stand-ins that draw the title they are handed.
vi.mock('../../components/SsoButton', async () => {
    const { createElement: h } = await import('react');
    const b = (sso: string) => ({ title, onPress }: { title: string; onPress: () => void }) => h('button', { onClick: onPress, 'data-sso': sso }, title);
    return { GoogleButton: b('google'), AppleButton: b('apple'), FacebookButton: b('facebook') };
});
vi.mock('../sso-signin', () => ({
    SsoSignInError: class extends Error { constructor(public reason: string, message: string) { super(message); } },
    returnToApp: vi.fn(async () => undefined),
}));
const lock = vi.hoisted(() => ({ prompts: [] as string[] }));
vi.mock('../LocalAuth', () => ({ authenticateUser: async (prompt: string) => { lock.prompts.push(prompt); return true; } }));
const link = vi.hoisted(() => ({ answer: null as any, notices: [] as string[], error: null as Error | null }));
vi.mock('../join-link', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../join-link')>()),
    linkSignIn: async (o: { phoneLock: (() => Promise<boolean>) | null; onSignInAgain?: (line: string) => void }) => {
        if (o.phoneLock) await o.phoneLock();
        for (const line of link.notices) o.onSignInAgain?.(line);
        if (link.error) throw link.error;
        return link.answer;
    },
}));
vi.mock('../one-way-back', () => ({ finishOneWayBack: vi.fn(async () => undefined) }));
const vault = vi.hoisted(() => ({ at: 'vault' as 'vault' | 'community' }));
vi.mock('../vault-config', async (importOriginal) => ({ ...(await importOriginal<typeof import('../vault-config')>()), signInCopiesAt: () => vault.at }));
const words = vi.hoisted(() => ({ result: { ok: false, reason: 'mismatch' } as any }));
vi.mock('../identity', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../identity')>()),
    addMnemonicToIdentity: async () => words.result,
}));
const appLock = vi.hoisted(() => ({ screen: 'lock' as 'lock' | 'cover' | 'none' }));
vi.mock('../app-lock-screen', () => ({ appLockScreen: () => appLock.screen, askToUnlockApp: () => {}, useAppLockScreen: () => appLock.screen }));
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

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { DrawnInLanguage, LanguageProvider } from '../../components/LanguageProvider';
import { LanguagePickerSheet } from '../../components/LanguagePicker';
import { LinkSignInSheet, linkRefusalWords, linkedNoticeWords } from '../../components/LinkSignInSheet';
import { TotpCodeDialog } from '../../components/TotpCodeDialog';
import { RecoveryWordsEntry } from '../../components/RecoveryWordsEntry';
import { DOOR_CHOICE_TEXT, DoorChoices, DoorWorkProgress, WORDS_BACKUP_TEXT, WordsBackupNote, settingUpWords } from '../../components/WordsDoor';
import { AddWordsForm, addWordsLine, wordBoxesStatusWords } from '../../components/AddWordsForm';
import { AppLockScreenView } from '../../components/AppLock';
import { LINK_MESSAGES, linkedNotice, type LinkAnswer, type LinkRefusal } from '../join-link';
import { SsoSignInError } from '../sso-signin';
import { ADD_WORDS_COPY, checkWordBoxes, wordBoxesStatus } from '../add-words';
import { DOOR_WORK_MESSAGES } from '../door-work';
import { SSO_PROVIDER_NAMES } from '../sso-providers';
import { bypassing, unfit } from './key-words-harness';

/** Provider names, a community's name: shown as written. */
const WRITTEN = ['Google', 'Apple', 'Facebook', 'Riverbend', 'BeanPool'];
const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Ana' };
/** Twelve words from the list, typed as a member would. */
const TWELVE = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    lock.prompts.length = 0;
    link.notices = [];
    link.error = null;
    store.map.clear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, element: unknown) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, element as any) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
const buttonWith = (english: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(pseudoLocalise(english))) ?? null;
const sheet = (extra: Record<string, unknown> = {}) => createElement(LinkSignInSheet, {
    visible: true, onClose() {}, onLinked() {}, identity: IDENTITY as any, url: 'https://global.example', ...extra,
});

describe('"Add a sign-in as a second way back" in the pseudo-locale', () => {
    it('the choice, the phone\'s lock, the second-way check and the added notice: all through t()', async () => {
        link.answer = { kind: 'linked', provider: 'google', enrolment: { ok: true } };
        link.notices = ['Checking your sign-in another way…'];
        await renderIn('xx', sheet());
        expect(host.querySelector('[role="heading"]')?.textContent).toBe(pseudoLocalise('Add a sign-in as a second way back'));
        expect(host.querySelector('[data-sso="google"]')?.textContent).toBe(pseudoLocalise('Continue with {provider}').replace('{provider}', 'Google'));
        expect(bypassing(host, WRITTEN)).toEqual([]);
        await click(host.querySelector('[data-sso="google"]'), 'Google');
        expect(lock.prompts).toEqual([pseudoLocalise('Confirm authentication to add a sign-in to your account.')]);
        expect(host.textContent).toContain(pseudoLocalise('✅ Sign-in added'));
        expect(host.textContent).toContain(pseudoLocalise('Your {provider} sign-in is added: your account now has the usual new-account limits. If you lose this phone, sign in with {provider} to get back in.').split('{provider}').join('Google'));
        expect(bypassing(host, WRITTEN)).toEqual([]);
    });

    it("a sign-in that timed out says so in the member's language, the provider as sso-signin.ts writes it", async () => {
        link.error = new SsoSignInError('provider', 'google sign-in timed out.');
        await renderIn('xx', sheet());
        await click(host.querySelector('[data-sso="google"]'), 'Google');
        expect(host.querySelector('[role="alert"]')?.textContent).toBe(pseudoLocalise('{provider} sign-in timed out.').replace('{provider}', 'google'));
        expect(bypassing(host, WRITTEN)).toEqual([]);
        // 320 - 2 × 24 (the sheet's padding), at 1.3×.
        expect(unfit(host, 320 - 48)).toEqual([]);
    });

    it('a refusal, by its reason; one with a time in it as it came; and Try again', async () => {
        link.answer = { kind: 'refused', reason: 'already_joined', message: LINK_MESSAGES.already_joined.replace('{provider}', 'Facebook') };
        await renderIn('xx', sheet());
        await click(host.querySelector('[data-sso="facebook"]'), 'Facebook');
        expect(host.textContent).toContain(pseudoLocalise('Not added'));
        expect(host.textContent).toContain(pseudoLocalise(LINK_MESSAGES.already_joined).replace('{provider}', 'Facebook'));
        expect(buttonWith('Try again')).not.toBeNull();
        expect(bypassing(host, WRITTEN)).toEqual([]);
    });

    it('at 320 dp and 1.3×: no word wider than the sheet, nothing stuck in a row', async () => {
        link.answer = { kind: 'refused', reason: 'unreachable', message: LINK_MESSAGES.unreachable };
        await renderIn('xx', sheet());
        // 320 - 2 × 24 (the sheet's padding).
        expect(unfit(host, 320 - 48)).toEqual([]);
        await click(host.querySelector('[data-sso="google"]'), 'Google');
        expect(unfit(host, 320 - 48)).toEqual([]);
    });
});

describe('the sign-in sheet follows a language picked while it is open', () => {
    const fr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words/fr.json'), 'utf8')) as Record<string, unknown>;

    it('a pick redraws it in the new language from the real catalog', async () => {
        await act(async () => {
            // As the app draws every screen: inside DrawnInLanguage, which draws it again on a pick (app/_layout.tsx).
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, sheet()), createElement(LanguagePickerSheet, { visible: true, onClose() {} })) as any);
        });
        await settle();
        expect(host.textContent).toContain('Not now');
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        expect(typeof fr['Not now']).toBe('string');
        expect(host.textContent).toContain(fr['Not now'] as string);
        expect(host.textContent).not.toContain('Not now');
        // A sentence the drafting pass hasn't reached yet reads in English, never blank (the key is the English).
        expect(host.textContent).toContain(fr['Add a sign-in as a second way back'] as string ?? 'Add a sign-in as a second way back');
    });
});

describe('the 2FA code, the 12 boxes, the door\'s two ways in, Safety Backup\'s note, App Lock: in the pseudo-locale', () => {
    it('the node\'s 2FA code: its words and a wrong code', async () => {
        await renderIn('xx', createElement(TotpCodeDialog, {
            visible: true, communityName: 'Riverbend', wrongCode: true, busy: false, code: '', onChangeCode() {}, onSubmit() {}, onCancel() {}, submitLabel: pseudoLocalise('Sign in'),
        }));
        expect(host.querySelector('[role="heading"]')?.textContent).toBe(pseudoLocalise('2FA code for {name}').replace('{name}', 'Riverbend'));
        expect(bypassing(host, WRITTEN)).toEqual([]);
        // 320 - 2 × 16 - 2 × 20 - 2 × 1.
        expect(unfit(host, 320 - 74)).toEqual([]);
    });

    it('the 12 boxes: labels through t(), the words typed shown as typed', async () => {
        await renderIn('xx', createElement(RecoveryWordsEntry, { words: TWELVE, onChange() {} }));
        expect(host.textContent).toContain(pseudoLocalise('Enter your 12 recovery words.'));
        expect(host.querySelector('input')?.getAttribute('aria-label')).toBe(pseudoLocalise('Recovery word {n}').replace('{n}', '1'));
        expect(Array.from(host.querySelectorAll('input')).map((i) => (i as HTMLInputElement).value)).toEqual(TWELVE);
        expect(bypassing(host, WRITTEN)).toEqual([]);
    });

    it('the global door: both ways in, the work bar, and Safety Backup\'s note', async () => {
        await renderIn('xx', createElement('div', null,
            createElement(DoorChoices, { onWords() {}, onSignIn() {}, signInNote: pseudoLocalise('A note the screen hands it.') }),
            createElement(DoorWorkProgress, { state: null }),
            createElement(WordsBackupNote, {})));
        expect(host.textContent).toContain(pseudoLocalise(DOOR_CHOICE_TEXT.words));
        expect(host.textContent).toContain(pseudoLocalise(DOOR_WORK_MESSAGES.settingUp));
        expect(host.textContent).toContain(pseudoLocalise(WORDS_BACKUP_TEXT.title));
        expect(bypassing(host, WRITTEN)).toEqual([]);
        expect(unfit(host, 320 - 32 - 34)).toEqual([]);
    });

    it('the global door for an existing account: both ways in through t(), fitting at 320 dp', async () => {
        await renderIn('xx', createElement('div', null,
            createElement(DoorChoices, { account: 'existing', onWords() {}, onSignIn() {}, signInNote: pseudoLocalise('A note the screen hands it.') }),
            createElement(DoorWorkProgress, { state: null })));
        expect(host.textContent).toContain(pseudoLocalise(DOOR_CHOICE_TEXT.wordsExisting));
        expect(host.textContent).toContain(pseudoLocalise(DOOR_CHOICE_TEXT.wordsLineExisting));
        expect(host.textContent).toContain(pseudoLocalise(DOOR_CHOICE_TEXT.signInHeadingExisting));
        expect(host.textContent).toContain(pseudoLocalise(DOOR_CHOICE_TEXT.signInLineExisting));
        expect(host.textContent).not.toContain(pseudoLocalise(DOOR_CHOICE_TEXT.words));
        expect(host.textContent).not.toContain(pseudoLocalise(DOOR_CHOICE_TEXT.signInHeading));
        expect(bypassing(host, WRITTEN)).toEqual([]);
        expect(unfit(host, 320 - 32 - 34)).toEqual([]);
    });

    it('welcome.tsx\'s door (DoorChoices default mode) still shows "Create an account with 12 secret words"', async () => {
        await renderIn('en', createElement(DoorChoices, { onWords() {}, onSignIn() {} }));
        expect(host.textContent).toContain('Create an account with 12 secret words');
        expect(host.textContent).toContain('No Google, Apple or Facebook needed. Your 12 words are the only way back in.');
        expect(host.textContent).toContain('Or sign in');
        expect(host.textContent).not.toContain('Join with this account');
        expect(host.textContent).not.toContain('Also add a sign-in');
    });

    it('App Lock\'s screen', async () => {
        await renderIn('xx', createElement(AppLockScreenView, { screen: 'lock' }));
        expect(host.textContent).toContain(pseudoLocalise('Unlock App'));
        expect(bypassing(host, WRITTEN)).toEqual([]);
        // 320 - 2 × 32 (the card's padding), the card at most 320 wide.
        expect(unfit(host, 320 - 64)).toEqual([]);
    });
});

describe('"Add your 12 words to this phone" in the pseudo-locale', () => {
    it('the form, a word not on the list, and why the save didn\'t keep them', async () => {
        await renderIn('xx', createElement(AddWordsForm, { onAdded() {}, onCancel() {} }));
        expect(host.querySelector('[role="heading"]')?.textContent?.trim()).toBe(pseudoLocalise(ADD_WORDS_COPY.title));
        expect(bypassing(host, WRITTEN)).toEqual([]);
        // Twelve words, one not on the list: its box number, never the word, in the status line.
        const inputs = Array.from(host.querySelectorAll('input')) as HTMLInputElement[];
        for (const [i, w] of [...TWELVE.slice(0, 11), 'zzzz'].entries()) {
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[i], w);
                inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
            });
        }
        await settle();
        expect(host.textContent).toContain(pseudoLocalise('Word {n} is not on the list of recovery words. Check the spelling.').replace('{n}', '12'));
        expect(bypassing(host, [...WRITTEN, ...TWELVE, 'zzzz'])).toEqual([]);
    });

    it('a save the phone refused says so in the member\'s language', async () => {
        words.result = { ok: false, reason: 'mismatch' };
        await renderIn('xx', createElement(AddWordsForm, { onAdded() {}, onCancel() {} }));
        clip.text = TWELVE.join(' ');
        await click(buttonWith('📋 Paste'), 'Paste');
        await click(host.querySelector(`[aria-label="${pseudoLocalise(ADD_WORDS_COPY.submit)}"]`), 'Add these words');
        expect(host.textContent).toContain(pseudoLocalise(ADD_WORDS_COPY.mismatch));
        expect(bypassing(host, [...WRITTEN, ...TWELVE])).toEqual([]);
        // 320 - 2 × 16 (Settings' card) - 2 × 16: two boxes to a row, each 48 %.
        expect(unfit(host, 320 - 64)).toEqual([]);
    });
});

describe('the sentences join-link.ts, add-words.ts and door-work.ts write: in English exactly as they do, translated otherwise', () => {
    const reasons = Object.keys(LINK_MESSAGES) as LinkRefusal[];

    it('every refusal of a sign-in link, for every provider; one with a time in it as it came', () => {
        for (const provider of ['google', 'apple', 'facebook'] as const) {
            for (const reason of reasons) {
                const message = LINK_MESSAGES[reason].replace('{provider}', SSO_PROVIDER_NAMES[provider]).replace('{when}', 'later');
                const answer = { kind: 'refused', reason, message } as Extract<LinkAnswer, { kind: 'refused' }>;
                expect(linkRefusalWords(answer, provider), reason).toBe(message);
                setLanguage('xx');
                expect(linkRefusalWords(answer, provider), reason).toMatch(/^\[.*\]$/s);
                setLanguage('en');
            }
        }
        const timed = { kind: 'refused', reason: 'rate_limited', message: LINK_MESSAGES.rate_limited.replace('{when}', 'in 5 minutes') } as Extract<LinkAnswer, { kind: 'refused' }>;
        setLanguage('xx');
        expect(linkRefusalWords(timed, 'google')).toBe(timed.message);
    });

    it('the added notice, with a copy at the vault, at the community, and none', () => {
        for (const at of ['vault', 'community'] as const) {
            vault.at = at;
            for (const enrolment of [{ ok: true }, null]) {
                const answer = { kind: 'linked', provider: 'apple', enrolment } as Extract<LinkAnswer, { kind: 'linked' }>;
                expect(linkedNoticeWords(answer)).toBe(linkedNotice(answer));
            }
        }
    });

    it('the add form\'s lines, its status line for every count, and the work bar\'s line', () => {
        for (const which of ['title', 'submit', 'checking', 'cancel', 'mismatch', 'malformed', 'failed'] as const) expect(addWordsLine(which)).toBe(ADD_WORDS_COPY[which]);
        expect(ADD_WORDS_COPY.paste).toBe('Paste');
        const shapes = [Array(12).fill(''), [...TWELVE.slice(0, 5), ...Array(7).fill('')], TWELVE, [...TWELVE.slice(0, 11), 'zzzz'], ['zzzz', ...TWELVE.slice(1, 10), 'qqqq', 'xxxx']];
        for (const boxes of shapes) expect(wordBoxesStatusWords(checkWordBoxes(boxes))).toBe(wordBoxesStatus(checkWordBoxes(boxes)));
        expect(settingUpWords()).toBe(DOOR_WORK_MESSAGES.settingUp);
        setLanguage('xx');
        for (const which of ['title', 'submit', 'checking', 'cancel', 'mismatch', 'malformed', 'failed'] as const) expect(addWordsLine(which)).toBe(pseudoLocalise(ADD_WORDS_COPY[which]));
        expect(settingUpWords()).toBe(pseudoLocalise(DOOR_WORK_MESSAGES.settingUp));
    });
});
