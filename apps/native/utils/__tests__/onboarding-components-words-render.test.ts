// @vitest-environment jsdom
/**
 * The components welcome draws that sweep B9 took (words slice S3), each whole and in every state, rendered for real
 * inside the real LanguageProvider in the pseudo-locale: How BeanPool works (OnboardingGuide, with Beans and without),
 * the working-style quiz (its intro, a question, its result), the account-protection panel (a vault build and a
 * community build; covered by one and by two sign-ins, with Connect again and Disconnect; the 12 words; no words), the
 * sign-in sheet (connecting, linked, linked over another account's sign-in, not linked), the recovery kit's buttons (the
 * question before Save as PDF, and the failure) and the notes under the 12 words.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint
 * or alert with letters outside a bracket bypassed t(). The sign-ins' brand names show as they are. Then 320 dp at 1.3×:
 * no word of a button is wider than its line, and a Text that sits in a row which doesn't wrap may shrink there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Some components don't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
const prompts = vi.hoisted(() => ({ asked: [] as string[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio', alert: 'alert', progressbar: 'progressbar' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, accessibilityValue, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityValue?.text) attrs['aria-valuetext'] = accessibilityValue.text;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        const s = flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        if (s.flexDirection === 'row') attrs['data-row'] = 'true';
        if (s.flexWrap === 'wrap') attrs['data-wrap'] = 'true';
        if ((typeof s.flexShrink === 'number' && s.flexShrink > 0) || (typeof s.flex === 'number' && s.flex > 0)) attrs['data-shrink'] = 'true';
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), SafeAreaView: el('div'), TouchableOpacity: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                for (const b of buttons ?? []) if (b.text) alerts.said.push(b.text);
            },
        },
        AppState: { currentState: 'active', addEventListener: listener },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', () => ({ useIsFocused: () => true, router: { push() {} } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-linking', () => ({ addEventListener: () => ({ remove() {} }), openURL: async () => undefined }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: async () => ({ type: 'cancel' }), openBrowserAsync: async () => ({}), dismissAuthSession() {}, dismissBrowser: async () => undefined }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: async () => false, signInAsync: async () => ({}), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), digest: async () => new ArrayBuffer(32) };
});
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true, getStringAsync: async () => '' }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: true }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, getAllKeys: async () => [], multiRemove: async () => {} },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx), useOnboardingColors: () => onboardingColors('light') };
});
const ME = vi.hoisted(() => ({ publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32), callsign: 'Sally', createdAt: '2026-01-01' }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME, setIdentity() {} }) }));
vi.mock('../../components/SsoButton', () => {
    const button = (name: string) => ({ title, onPress }: { title?: string; onPress: () => void }) => createElement('button', { role: 'button', 'aria-label': title, 'data-sso': name, onClick: onPress }, title);
    return { GoogleButton: button('google'), AppleButton: button('apple'), FacebookButton: button('facebook') };
});
const sheet = vi.hoisted(() => ({ answer: null as null | Promise<unknown> }));
vi.mock('../sso-sheet-connect', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-sheet-connect')>();
    return { ...real, connectAndDeposit: async () => sheet.answer };
});
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    return { ...real, returnToApp: async () => {} };
});
vi.mock('../node-post', async (importOriginal) => {
    const real = await importOriginal<typeof import('../node-post')>();
    return { ...real, anchorUrl: async () => 'https://mullum.beanpool.org' };
});
vi.mock('../nodes', async (importOriginal) => {
    const real = await importOriginal<typeof import('../nodes')>();
    return { ...real, getSavedNodes: async () => [{ url: 'https://mullum.beanpool.org', alias: 'Mullum' }] };
});
const kit = vi.hoisted(() => ({ print: 'done' as string }));
vi.mock('../recovery-kit', async (importOriginal) => {
    const real = await importOriginal<typeof import('../recovery-kit')>();
    return {
        ...real,
        printRecoveryKit: async () => kit.print,
        // As the real one: asked first, nothing made on Cancel.
        saveRecoveryKitPdf: async (_kit: unknown, askFirst: () => Promise<boolean>) => ((await askFirst()) ? 'done' : 'cancelled'),
    };
});
vi.mock('../words-on-screen', async (importOriginal) => {
    const real = await importOriginal<typeof import('../words-on-screen')>();
    return { ...real, useNoScreenLock: () => true, holdNoScreenCapture: () => ({ answered: Promise.resolve(), release() {} }) };
});

import { DEEP_RESONANCE_QUESTIONS, QUICK_SPARK_QUESTIONS, pseudoLocalise, setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { OnboardingGuide } from '../../components/OnboardingGuide';
import { ArchetypeQuizModal } from '../../components/ArchetypeQuizModal';
import { KeeperProtectionPanel, SIGN_IN_ROW, VAULT_COPY_OPENERS } from '../../components/KeeperProtectionPanel';
import { SsoEnrolSheet } from '../../components/SsoEnrolSheet';
import { RecoveryKitButtons } from '../../components/RecoveryKitButtons';
import { CopyClearsNote, NoScreenLockNote } from '../../components/WordsOnScreen';
import { protectionFrom } from '../protection-state';
import { VAULT_MESSAGES } from '../vault';
import { SsoSignInError } from '../sso-signin';
import { noVault, useVault } from './fake-vault';

const WORDS = 'apple banana cherry delta eagle fabric garden hollow island jungle kettle lemon'.split(' ');
/** Shown as they are in every language. */
const AS_WRITTEN = ['Google', 'Apple', 'Facebook', 'Sally', 'mullum.beanpool.org'];

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => { alerts.said.length = 0; prompts.asked.length = 0; sheet.answer = null; kit.print = 'done'; noVault(); setLanguage('en'); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; noVault(); setLanguage('en'); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(node: unknown): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'xx' }, node as any) as any); });
    await settle();
    return host;
}
const all = (sel: string) => Array.from(host!.querySelectorAll(sel)) as HTMLElement[];
async function click(el: HTMLElement | undefined, what: string) {
    expect(el, what).toBeTruthy();
    await act(async () => { el!.click(); });
    await settle();
}

function outsideBrackets(text: string): string {
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const n of [...AS_WRITTEN].sort((a, b) => b.length - a.length)) rest = rest.split(n).join('');
    return rest.replace(/[^\p{L}]+/gu, ' ').trim();
}
function wholly(step: string) {
    const seen: string[] = [];
    for (const n of all('*')) {
        const own = Array.from(n.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join('');
        if (own.trim()) seen.push(own);
        for (const attr of ['aria-label', 'data-hint', 'aria-valuetext']) { const v = n.getAttribute(attr); if (v) seen.push(v); }
    }
    seen.push(...alerts.said, ...prompts.asked);
    expect(seen.length, `${step}: something is on screen`).toBeGreaterThan(1);
    expect(seen.filter((s) => outsideBrackets(s) !== ''), `${step}: English outside t()`).toEqual([]);
}

// ── 320 dp at 1.3× ────────────────────────────────────────────────────────────────────────────────────────────────
const FONT_SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) ? 0 : '\uFE0F\u200C\u200D\u200B'.includes(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, fontSize: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * fontSize * FONT_SCALE, 0);
const widestPiece = (text: string) => text.split(/[\s~[\]\u200B]+/).reduce((a, w) => (widthOf(w, 1) > widthOf(a, 1) ? w : a), '');
const fontOf = (el: Element | null): number => { for (let e = el; e; e = e.parentElement) { const f = e.getAttribute('data-font'); if (f) return Number(f); } return 16; };
/** No word of a button's words is wider than the line it has: `line` dp. */
function buttonsFit(step: string, line: number) {
    for (const b of all('button')) {
        for (const leaf of [b, ...Array.from(b.querySelectorAll('span'))]) {
            const own = Array.from(leaf.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join('');
            if (!own.trim()) continue;
            const piece = widestPiece(own);
            expect(widthOf(piece, fontOf(leaf)), `${step}: "${piece}" at ${fontOf(leaf)} on a ${line} dp line`).toBeLessThanOrEqual(line);
        }
    }
}
/** A Text in a row that doesn't wrap, longer than the row's line, may shrink there (and so wraps). */
function rowsWrap(step: string, line: number) {
    for (const row of all('[data-row]:not([data-wrap])')) {
        for (const child of Array.from(row.children) as HTMLElement[]) {
            if (child.tagName !== 'SPAN' || !/\p{L}/u.test(child.textContent ?? '')) continue;
            if (widthOf(child.textContent!, fontOf(child)) <= line) continue;
            expect(child.getAttribute('data-shrink'), `${step}: "${child.textContent}" runs past its row`).toBe('true');
        }
    }
}
/** Welcome's card at 320 dp: the scroll's 24 dp and the card's 24 dp a side. */
const CARD_LINE = 320 - 2 * 24 - 2 * 24;
const check = (step: string, line = CARD_LINE) => { wholly(step); buttonsFit(step, line); rowsWrap(step, line); };

describe('How BeanPool works (OnboardingGuide)', () => {
    it('with Beans: every card, its bold lead-ins inside their sentences', async () => {
        const page = await mount(createElement(OnboardingGuide, { beansOn: true }));
        expect(page.textContent).toContain(pseudoLocalise('🟢 {zero} This means you have given as much value to your community as you have received from it.').replace('{zero}', pseudoLocalise('The best place to be is zero (0 Beans).')));
        check('the guide, with Beans');
    });

    it('without Beans: the one card in place of the three, and no Ledger tip', async () => {
        const page = await mount(createElement(OnboardingGuide, { beansOn: false }));
        expect(page.textContent).toContain(pseudoLocalise('🌍 A place to meet'));
        expect(page.textContent).not.toContain(pseudoLocalise('Ledger'));
        check('the guide, without Beans');
    });
});

describe('the working-style quiz (ArchetypeQuizModal)', () => {
    it('the intro, every Quick Spark question, and the result', async () => {
        const page = await mount(createElement(ArchetypeQuizModal, { visible: true, onClose() {}, onComplete() {} }));
        check('the quiz, intro', 320 - 2 * 24 - 2 * 16 - 44 - 12);
        await click(all('button').find((b) => b.getAttribute('aria-label') === pseudoLocalise('Quick Spark: 9 questions, approx 1 minute. A 60-second snapshot of how you like to work.')), 'Quick Spark');
        for (let q = 0; q < QUICK_SPARK_QUESTIONS.length; q++) {
            expect(page.textContent).toContain(pseudoLocalise(QUICK_SPARK_QUESTIONS[q].prompt));
            expect(page.textContent).toContain(pseudoLocalise('Question {n} of {total}').replace('{n}', String(q + 1)).replace('{total}', '9'));
            // The option's text: 320 less the quiz's 20 dp and the option's 16 dp a side, its emoji (22 at 1.3×) and 12 dp.
            check(`the quiz, question ${q + 1}`, 320 - 2 * 20 - 2 * 16 - 22 * FONT_SCALE * 1.25 - 12);
            await click(all('[role="radio"]')[0], `an answer to question ${q + 1}`);
        }
        expect(page.textContent).toContain(pseudoLocalise('🌟 What you tend to enjoy'));
        check('the quiz, result', 320 - 2 * 20 - 2 * 24);
    });

    it('every Deep Resonance question and answer is a word() key the quiz shows with t()', async () => {
        const page = await mount(createElement(ArchetypeQuizModal, { visible: true, initialMode: 'deep', onClose() {}, onComplete() {} }));
        await click(all('button').find((b) => b.getAttribute('aria-label') === pseudoLocalise('Deep Resonance: 27 questions, approx 3 minutes. Recommended for deep accuracy.')), 'Deep Resonance');
        for (let q = 0; q < DEEP_RESONANCE_QUESTIONS.length; q++) {
            expect(page.textContent).toContain(pseudoLocalise(DEEP_RESONANCE_QUESTIONS[q].prompt));
            wholly(`the deep quiz, question ${q + 1}`);
            await click(all('[role="radio"]')[0], `an answer to question ${q + 1}`);
        }
        check('the deep quiz, result', 320 - 2 * 20 - 2 * 24);
    });
});

describe('the account-protection panel (KeeperProtectionPanel)', () => {
    const covered = (sso: string[]) => protectionFrom({ enrolled: sso.map(() => 'sso' as const), generation: 1, skipped: [], available: sso.length, enrolledSso: sso as any, threshold: 1, isSingleBlob: true });
    // Inside welcome's card or Settings' section: the panel's 16 dp a side, and the connected row's 12 dp.
    const ROW_LINE = CARD_LINE - 2 * 16 - 2 * 12;
    for (const vault of [true, false]) {
        it(`${vault ? 'a vault build' : 'a community build'}: covered by one and by two sign-ins, with Connect again and Disconnect`, async () => {
            if (vault) useVault();
            for (const sso of [['google'], ['google', 'facebook']]) {
                for (const hasWords of [true, false]) {
                    await mount(createElement(KeeperProtectionPanel, { protection: covered(sso), hasWords, communityName: 'https://mullum.beanpool.org', onProtectSso() {}, onDisconnectSso() {} }));
                    check(`the panel, ${vault ? 'vault' : 'community'}, ${sso.join('+')}, ${hasWords ? 'words' : 'no words'}`, ROW_LINE - 2 * 12);
                    act(() => root?.unmount()); host?.remove();
                }
            }
        });
        it(`${vault ? 'a vault build' : 'a community build'}: the 12 words as the way back, and a phone with none`, async () => {
            if (vault) useVault();
            for (const hasWords of [true, false]) {
                await mount(createElement(KeeperProtectionPanel, { protection: protectionFrom(null), hasWords, onProtectSso() {} }));
                check(`the panel, words only, ${hasWords ? 'words' : 'no words'}`);
                act(() => root?.unmount()); host?.remove();
            }
        });
    }
    // Vault rethink VR0: the row names the vault, and "Who can open it" opens the long sentence, closed when drawn.
    it('a vault build: "Who can open it" opens who can open the copy and closes it again, before a sign-in and after; Account Protection\'s row alone too', async () => {
        useVault();
        const openers = pseudoLocalise(VAULT_COPY_OPENERS);
        for (const [protection, waysBack] of [[protectionFrom(null), false], [protectionFrom(null), true], [covered(['google']), false]] as const) {
            for (const hasWords of [true, false]) {
                const step = `the panel, ${protection.state}, ${hasWords ? 'words' : 'no words'}${waysBack ? ', Account Protection' : ''}`;
                await mount(createElement(KeeperProtectionPanel, { protection, hasWords, waysBack, onProtectSso() {}, onDisconnectSso() {} }));
                expect(host!.textContent, step).toContain(pseudoLocalise(hasWords ? SIGN_IN_ROW.vaultKeeps : SIGN_IN_ROW.vaultKeepsKey));
                expect(host!.textContent, step).not.toContain(openers);
                const who = () => all('button').find((b) => b.getAttribute('aria-label') === pseudoLocalise(SIGN_IN_ROW.whoCanOpenButton));
                await click(who(), `${step}: Who can open it`);
                expect(host!.textContent, step).toContain(openers);
                check(`${step}, opened`, ROW_LINE);
                await click(who(), `${step}: Who can open it, again`);
                expect(host!.textContent, step).not.toContain(openers);
                act(() => root?.unmount()); host?.remove();
            }
        }
    });
});

describe('the sign-in sheet (SsoEnrolSheet)', () => {
    const open = () => createElement(SsoEnrolSheet, { visible: true, provider: 'google', askPhoneLock: false, onClose() {}, onEnrolled() {} });
    it('connecting, with Cancel', async () => {
        sheet.answer = new Promise(() => {});
        await mount(open());
        expect(host!.textContent).toContain(pseudoLocalise('Connecting with {provider}...').replace('{provider}', 'Google'));
        check('the sheet, connecting');
    });
    it("a sign-in that timed out: the sheet's sentence and the timeout's, the provider as sso-signin.ts writes it", async () => {
        const timedOut = Promise.reject(new SsoSignInError('provider', 'google sign-in timed out.'));
        timedOut.catch(() => {});
        sheet.answer = timedOut;
        await mount(open());
        const reason = pseudoLocalise('{provider} sign-in timed out.').replace('{provider}', 'google');
        expect(host!.textContent).toContain(pseudoLocalise('{provider} sign-in failed: {reason}').replace('{provider}', 'Google').replace('{reason}', reason));
        check('the sheet, timed out');
    });
    for (const vault of [true, false]) {
        it(`${vault ? 'a vault build' : 'a community build'}: linked over another account's sign-in, stays up until Done`, async () => {
            if (vault) useVault();
            sheet.answer = Promise.resolve({ enrolled: ['sso'], generation: 1, skipped: [], available: 1, enrolledSso: ['google'], replaced: true });
            await mount(open());
            expect(host!.textContent).toContain(pseudoLocalise('This {provider} account used to protect a different BeanPool account. It protects this one now, and that one has only its 12 words.').replace('{provider}', 'Google'));
            check(`the sheet, linked, ${vault ? 'vault' : 'community'}`);
        });
        it(`${vault ? 'a vault build' : 'a community build'}: not linked, the key vault's own sentence in the member's language`, async () => {
            if (vault) useVault();
            sheet.answer = Promise.resolve({ error: VAULT_MESSAGES.paused });
            await mount(open());
            expect(host!.textContent).toContain(pseudoLocalise(VAULT_MESSAGES.paused));
            check(`the sheet, not linked, ${vault ? 'vault' : 'community'}`);
        });
    }
});

describe("the recovery kit's buttons and the notes under the 12 words", () => {
    it('Save as PDF asks first in the member\'s language; a kit that can\'t be made says so', async () => {
        await mount(createElement('div', null,
            createElement(RecoveryKitButtons, { key: 'kit', words: WORDS }),
            createElement(NoScreenLockNote, { key: 'lock' }),
            createElement(CopyClearsNote, { key: 'copy' })));
        check('the kit and the notes');
        kit.print = 'failed';
        await click(all('button').find((b) => b.getAttribute('aria-label') === pseudoLocalise('Print your recovery kit')), 'Print your recovery kit');
        expect(alerts.said).toEqual([pseudoLocalise('Recovery kit'), pseudoLocalise('The recovery kit couldn’t be made on this phone. Write the 12 words down instead.')]);
        check('the kit, failed');
        alerts.said.length = 0;
        // The question stays up until answered (nothing answers it here).
        await click(all('button').find((b) => b.getAttribute('aria-label') === pseudoLocalise('Save as PDF')), 'Save as PDF');
        expect(alerts.said).toEqual([pseudoLocalise('Save as PDF'), pseudoLocalise('Keep this file off cloud backups and chats. Anyone who has it can sign in as you.'), pseudoLocalise('Cancel'), pseudoLocalise('Save')]);
        check('the kit, before Save as PDF');
    });
});
