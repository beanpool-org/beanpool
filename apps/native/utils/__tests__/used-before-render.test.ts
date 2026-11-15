// @vitest-environment jsdom
/**
 * "Used BeanPool before?" first, on a phone with no account (Marty, 12 Nov idea 2, yes on 15 Nov): components/welcome/
 * UsedBefore.tsx, drawn by app/welcome.tsx's home through utils/first-question.ts.
 *
 * Rendered for real: the question and its two answers, in order; each answer goes only where it says; the ways back are
 * all reachable from "I'm Already a Member", best first (sign-in, the 12 words, then the community and an admin); "Start a
 * new account instead" says plainly that it makes a new account; and nothing makes an account until the person chooses a
 * join on the doors. The screen itself is too big to draw in a test, so its wiring is read from its source, as
 * welcome-doors-render.test.ts reads the doors' place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => { if (!disabled) onPress(); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (accessibilityRole === 'header') attrs['data-header'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));

import { UsedBefore, StartNewInstead } from '../../components/welcome/UsedBefore';
import { RestoreMenu } from '../../components/welcome/RestoreMenu';
import { LanguageProvider } from '../../components/LanguageProvider';
import { setLanguage } from '@beanpool/core';
import { homeView, offersStartNew } from '../first-question';
import { onboardingColors } from '../onboarding-colors';

const QUESTION_STYLES = { homeDoors: {}, usedBeforeQuestion: {}, memberBtn: {}, memberBtnText: {}, inviteOnlyHint: {} };
const START_NEW_STYLES = { restorePromptBox: {}, restorePromptLabel: {}, restorePromptBtn: {}, restorePromptBtnText: {} };
const welcome = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf-8');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    setLanguage('en');
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

async function draw(node: ReturnType<typeof createElement>): Promise<void> {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, node) as any); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const buttons = () => Array.from(host.querySelectorAll('[role="button"]')) as HTMLElement[];
const reading = () => Array.from(host.querySelectorAll('span')).filter((s) => s.children.length === 0).map((s) => s.textContent ?? '');

/** The body of the JSX element in welcome.tsx that starts at `start`, up to the first `end` after it. */
function slice(start: string, end: string): string {
    const at = welcome.indexOf(start);
    expect(at, `welcome.tsx has ${start}`).toBeGreaterThan(-1);
    const stop = welcome.indexOf(end, at);
    expect(stop, `welcome.tsx has ${end} after ${start}`).toBeGreaterThan(at);
    return welcome.slice(at, stop);
}

describe('which first screen the home draws (utils/first-question.ts)', () => {
    it.each([
        // [has an account, waiting to be let in, answer, view]
        [false, false, null, 'question'],
        [false, false, 'new', 'doors'],
        // A wait without an account can't happen; the question still comes first if it ever did.
        [false, true, null, 'question'],
        [true, true, null, 'waiting'],
        [true, true, 'new', 'waiting'],
        [true, false, null, 'doors'],
        [true, false, 'new', 'doors'],
    ] as const)('account %s, waiting %s, answer %s: %s', (hasAccount, waiting, answer, view) => {
        expect(homeView({ hasAccount, waiting, answer })).toBe(view);
    });

    it('"Start a new account instead" only where there is no account on this phone', () => {
        expect(offersStartNew(false)).toBe(true);
        expect(offersStartNew(true)).toBe(false);
    });
});

describe('the question and its two answers', () => {
    it('asks "Used BeanPool before?", then I\'m New Here, then I\'m Already a Member, and the line about a lost phone', async () => {
        const taps = { new: 0, returning: 0 };
        await draw(createElement(UsedBefore, { onNew: () => { taps.new++; }, onReturning: () => { taps.returning++; }, styles: QUESTION_STYLES }));
        expect(reading()).toEqual([
            'Used BeanPool before?',
            "I'm New Here",
            "I'm Already a Member →",
            "Lost or changed your phone? Tap I'm Already a Member to bring your account back, so you don't make a second one.",
        ]);
        expect(host.querySelector('[data-header="true"]')?.textContent).toBe('Used BeanPool before?');
        const [isNew, returning, ...more] = buttons();
        expect(more).toEqual([]);
        expect(isNew.getAttribute('aria-label')).toBe("I'm New Here");
        expect(returning.getAttribute('aria-label')).toBe("I'm Already a Member →");
        // Each goes only where it says.
        await act(async () => { isNew.click(); });
        expect(taps).toEqual({ new: 1, returning: 0 });
        await act(async () => { returning.click(); });
        expect(taps).toEqual({ new: 1, returning: 1 });
    });

    it('the answers use the web\'s own words for the same fork (apps/pwa WelcomePage)', () => {
        const web = fs.readFileSync(path.resolve(__dirname, '../../../pwa/src/pages/WelcomePage.tsx'), 'utf-8');
        for (const words of ["{t(\"I'm New Here\")}", "{t(\"I'm Already a Member →\")}", "{t('Used BeanPool before?')}"]) {
            expect(web, `the web says ${words}`).toContain(words);
        }
    });
});

describe('"Start a new account instead": never a dead end, and plain about what it does', () => {
    it('says it makes a new account, and its tap only calls back', async () => {
        let started = 0;
        await draw(createElement(StartNewInstead, { onStartNew: () => { started++; }, styles: START_NEW_STYLES }));
        expect(reading()).toEqual([
            "Can't bring your account back? You can start again, but that makes a new account. Your old account stays as it is, and the two can never be joined into one.",
            'Start a new account instead →',
        ]);
        const [button, ...more] = buttons();
        expect(more).toEqual([]);
        expect(button.getAttribute('aria-label')).toBe('Start a new account instead');
        await act(async () => { button.click(); });
        expect(started).toBe(1);
    });
});

describe('every way back is reachable from "I\'m Already a Member", best first', () => {
    it('the restore menu: sign-in first, then the 12 words, then the community, an admin\'s code and a browser, each working', async () => {
        const taps: string[] = [];
        await draw(createElement(RestoreMenu, {
            ...onboardingColors('light'), logos: null,
            onSocial: () => taps.push('social'), onWords: () => taps.push('words'), onCommunity: () => taps.push('community'),
            onRekey: () => taps.push('rekey'), onBrowser: () => taps.push('browser'),
        }));
        const rows = buttons();
        expect(rows.map((b) => b.querySelector('span')?.textContent)).toEqual([
            '🌐 Recover with Social',
            '🔑 Recover with 12 Words',
            '🤝 My community can bring me back',
            '🪪 An admin gave me a re-key code',
            '💻 Scan from a browser',
        ]);
        await act(async () => { for (const r of rows) r.click(); });
        expect(taps).toEqual(['social', 'words', 'community', 'rekey', 'browser']);
    });
});

describe('the welcome screen\'s wiring (app/welcome.tsx)', () => {
    it('the question is drawn on the home only when first-question says so, with the language switch first', () => {
        const question = slice('// --- THE FIRST QUESTION', '// --- MAIN WELCOME SCREEN ---');
        expect(question).toContain("if (mode === 'home' && homeView({ hasAccount: !!accountOnPhone, waiting: waitingToJoin, answer: firstAnswer }) === 'question')");
        expect(question.indexOf('<LanguageSwitch />')).toBeLessThan(question.indexOf('<UsedBefore'));
        // It comes after the waiting home, which an account on this phone keeps.
        expect(welcome.indexOf('// --- WAITING TO BE LET IN')).toBeLessThan(welcome.indexOf('// --- THE FIRST QUESTION'));
    });

    it('New here only shows the doors, and Already a Member only opens the ways back: neither makes an account', () => {
        const question = slice('<UsedBefore', '/>');
        expect(question).toContain("onNew={() => { setError(null); setFirstAnswer('new'); }}");
        expect(question).toContain("onReturning={() => { setError(null); setMode('member'); }}");
        // Nothing that makes a key or joins: those wait for a door the person chooses.
        expect(question).not.toMatch(/handle\w*(Create|Join)|generate|createIdentity|setIdentity|setPendingIdentity/);
    });

    it('from the ways back: each route opens, and Back returns to the question (no answer is kept)', () => {
        const menu = slice("if (mode === 'member') {", "// --- RECOVER FROM 12 WORDS ---");
        expect(menu).toContain("onSocial={() => { setMode('ssoRecover'); setError(null); }}");
        expect(menu).toContain("onWords={() => { setMode('recover'); setError(null); }}");
        expect(menu).toContain("onCommunity={() => { setError(null); router.push({ pathname: '/rekey-code', params: { bringBack: '1' } }); }}");
        expect(menu).toContain("onRekey={() => { setError(null); router.push('/rekey-code'); }}");
        expect(menu).toContain("onBrowser={() => { setError(null); router.push('/pair-in'); }}");
        expect(menu).toContain('onPress={goBack}');
        expect(slice('function goBack() {', '}')).toContain("setMode('home')");
        // The question asked no answer was kept when it opened the ways back, so Back there asks it again.
        expect(slice('<UsedBefore', '/>')).not.toMatch(/onReturning=\{[^}]*setFirstAnswer/);
    });

    it('"Start a new account instead" is under the ways back where there is no account, and only opens the doors', () => {
        const menu = slice("if (mode === 'member') {", "// --- RECOVER FROM 12 WORDS ---");
        expect(menu).toContain('{offersStartNew(!!accountOnPhone) && (');
        const startNew = slice('<StartNewInstead', '/>');
        expect(startNew).toContain("onStartNew={() => { setError(null); setFirstAnswer('new'); setMode('home'); }}");
        expect(startNew).not.toMatch(/handle\w*(Create|Join)|generate|createIdentity|setIdentity|setPendingIdentity/);
        // Under the five ways, above Back.
        expect(menu.indexOf('<RestoreMenu')).toBeLessThan(menu.indexOf('<StartNewInstead'));
        expect(menu.indexOf('<StartNewInstead')).toBeLessThan(menu.indexOf('onPress={goBack}'));
    });

    it('back from the 12 words and from the sign-in restore returns to the ways back', () => {
        const words = slice("if (mode === 'recover') {", "if (mode === 'ssoRecover'");
        expect(words).toContain("setMode('member')");
        const signIn = welcome.slice(welcome.indexOf("if (mode === 'ssoRecover'"), welcome.indexOf('// --- WAITING TO BE LET IN'));
        expect(signIn.match(/setMode\('member'\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });

    it('the doors have a Back to the question on a phone with no account', () => {
        const doors = slice('// --- MAIN WELCOME SCREEN ---', 'function makeStyles');
        const back = slice('testID="welcome-doors-back"', '</Pressable>');
        expect(doors).toContain('{!accountOnPhone && (');
        expect(welcome.slice(welcome.lastIndexOf('<Pressable', welcome.indexOf('testID="welcome-doors-back"')), welcome.indexOf('testID="welcome-doors-back"')))
            .toContain('setFirstAnswer(null)');
        expect(back).toContain("{t('← Back')}");
    });
});
