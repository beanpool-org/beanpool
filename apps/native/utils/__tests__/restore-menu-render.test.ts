// @vitest-environment jsdom
/**
 * The ways back on a new phone: "I've used BeanPool before" on the front door (components/welcome/FrontDoor.tsx) opens
 * welcome's member mode, "🔑 Restore your account", which draws components/welcome/RestoreMenu.tsx. Moved here from
 * welcome-doors-render.test.ts and used-before-render.test.ts when the front door replaced the doors and the question
 * (review of #3317: deleting those files deleted every test of the ways back, and the code is unchanged).
 *
 * Rendered for real: the five rows in order (Social, 12 Words, My community can bring me back, An admin gave me a re-key
 * code, Scan from a browser), each tap reaching its own handler, the third and fifth with their hints, no line limit on any
 * label, every word through t(), and the width of the third row and its hint in every language at 320 dp with text at 1.3×.
 * Then the member mode's wiring, read from welcome.tsx's source (the screen is drawn whole, from the front door's tap, in
 * welcome-invite-post-render.test.ts §6): each row's handler and where it goes, "Start a new account instead" under the
 * rows and above Back, and Back from the 12 words and from the sign-in restore to the ways back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The component doesn't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, disabled, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => { if (!disabled) onPress(); };
        if (disabled) attrs['data-disabled'] = 'true';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
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

import { RestoreMenu } from '../../components/welcome/RestoreMenu';
import { LanguageProvider } from '../../components/LanguageProvider';
import { setLanguage, type UiLang } from '@beanpool/core';
import { onboardingColors } from '../onboarding-colors';

const welcome = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf-8');
const restoreMenu = fs.readFileSync(path.resolve(__dirname, '../../components/welcome/RestoreMenu.tsx'), 'utf-8');
const LABELS = ['🌐 Recover with Social', '🔑 Recover with 12 Words', '🤝 My community can bring me back', '🪪 An admin gave me a re-key code', '💻 Scan from a browser'];
const HINT_LINE = 'For members of a local community.';
const BROWSER_HINT = 'For an account you use in a web browser.';

let host: HTMLDivElement;
let root: Root;
let taps: string[] = [];
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    taps = [];
    setLanguage('en');
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

async function drawMenu(initial?: UiLang): Promise<void> {
    const menu = createElement(RestoreMenu, {
        ...onboardingColors('light'), logos: null,
        onSocial: () => { taps.push('social'); }, onWords: () => { taps.push('words'); },
        onCommunity: () => { taps.push('community'); }, onRekey: () => { taps.push('rekey'); },
        onBrowser: () => { taps.push('browser'); },
    });
    await act(async () => {
        root.render((initial ? createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial }, menu) : menu) as any);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const buttons = () => Array.from(host.querySelectorAll('[role="button"]')) as HTMLElement[];
/** Everything a member reads, top to bottom. */
const reading = () => Array.from(host.querySelectorAll('span')).filter((s) => s.children.length === 0).map((s) => s.textContent ?? '');

describe('Restore your account: five rows, best first (vault rethink VR4; front doors S9 adds the fifth)', () => {
    it('draws the five rows in order, the third and the fifth with their hints', async () => {
        await drawMenu();
        const rows = buttons();
        expect(rows).toHaveLength(5);
        expect(rows.map((b) => b.querySelector('span')?.textContent)).toEqual(LABELS);
        expect(reading()).toEqual([LABELS[0], LABELS[1], LABELS[2], HINT_LINE, LABELS[3], LABELS[4], BROWSER_HINT]);
        expect(rows[2].getAttribute('data-hint')).toBe(HINT_LINE);
        expect(rows[4].getAttribute('data-hint')).toBe(BROWSER_HINT);
        for (const r of rows) expect(r.getAttribute('data-disabled')).toBeNull();
    });

    // One tap at a time, each reaching its own handler and no other: a row wired to its neighbour's handler goes red here.
    LABELS.forEach((label, i) => {
        const way = ['social', 'words', 'community', 'rekey', 'browser'][i];
        it(`${label}: its tap reaches ${way}, and only ${way}`, async () => {
            await drawMenu();
            await act(async () => { buttons()[i].click(); });
            expect(taps).toEqual([way]);
        });
    });

    it('no label has a line limit, so a long one wraps and none is cut', async () => {
        await drawMenu();
        for (const b of buttons()) for (const s of Array.from(b.querySelectorAll('span'))) expect(s.getAttribute('data-lines')).toBeNull();
        // The label's Text, centred in its button, wraps there too: nothing here gives it a width of its own.
        expect(restoreMenu).toMatch(/recoverBtnText: \{[^}]*textAlign: 'center'/);
    });

    it('every word is through t(): in the pseudo-locale all five, and both hints, are their translations', async () => {
        await drawMenu('xx');
        const read = reading();
        expect(read).toHaveLength(7);
        for (const piece of read) expect(piece, `"${piece}" bypassed t()`).toMatch(/^\[.*\]$/s);
        for (const b of buttons()) {
            const hint = b.getAttribute('data-hint');
            if (hint) expect(hint, `"${hint}" bypassed t()`).toMatch(/^\[.*\]$/s);
        }
    });

    // The menu's column: the scroll's and the card's padding, then the button's. At 1.3× on 320 dp a word wider than this
    // would be cut mid-word by the button's edge: measured with the doors' generous glyph widths, in every language.
    const SCROLL = 24;
    const CARD = 24;
    const BUTTON = 16;
    const LINE_WIDTH = 320 - 2 * (SCROLL + CARD + BUTTON);
    const FONT = 16 * 1.3;
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
    const em = (c: string) => (/\p{M}/u.test(c) ? 0 : /[\ufe0f\u200c\u200d]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : CJK.test(c) ? 1 : 0.62);
    const widest = (s: string) => Math.max(...s.split(/\s+/).flatMap((w) => (CJK.test(w) ? Array.from(w) : [w])).map((w) => Array.from(w).reduce((n, c) => n + em(c) * FONT, 0)));

    it('the styles the measure rests on are the screen\'s and the rows\'', () => {
        expect(welcome).toMatch(/\n\s*scroll: \{[^}]*padding: 24/);
        expect(welcome).toMatch(/\n\s*card: \{[^}]*padding: 24/);
        expect(restoreMenu).toMatch(/\n\s*recoverBtn: \{[^}]*padding: 16/);
        expect(restoreMenu).toMatch(/\n\s*recoverBtnText: \{[^}]*fontSize: 16/);
    });

    const NATIVE_WORDS = path.resolve(__dirname, '../../words');
    for (const lang of ['en', ...fs.readdirSync(NATIVE_WORDS).filter((f) => /^[A-Za-z-]+\.json$/.test(f)).map((f) => f.slice(0, -5))]) {
        it(`${lang}: the third row is there, and no word in it or its hint is wider than its button`, () => {
            const cat = lang === 'en' ? {} : JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, `${lang}.json`), 'utf8')) as Record<string, string>;
            const say = (k: string) => (lang === 'en' ? k : cat[k]);
            for (const k of [LABELS[2], HINT_LINE]) {
                expect(typeof say(k), k).toBe('string');
                expect(widest(say(k)), say(k)).toBeLessThanOrEqual(LINE_WIDTH);
            }
        });
    }
});

describe('the member mode\'s wiring (app/welcome.tsx), reached from the front door\'s "I\'ve used BeanPool before"', () => {
    /** The body of welcome.tsx from `start` up to the first `end` after it. */
    function slice(start: string, end: string): string {
        const at = welcome.indexOf(start);
        expect(at, `welcome.tsx has ${start}`).toBeGreaterThan(-1);
        const stop = welcome.indexOf(end, at);
        expect(stop, `welcome.tsx has ${end} after ${start}`).toBeGreaterThan(at);
        return welcome.slice(at, stop);
    }
    const menu = () => slice("if (mode === 'member') {", '// --- RECOVER FROM 12 WORDS ---');

    it('the front door\'s "I\'ve used BeanPool before" opens the ways back, and makes no account', () => {
        const door = slice('<FrontDoor', '/>');
        expect(door).toContain("onUsedBefore={() => { setError(null); setMode('member'); }}");
        expect(menu()).toContain('<RestoreMenu');
    });

    it.each([
        ['onSocial', "onSocial={() => { setMode('ssoRecover'); setError(null); }}"],
        ['onWords', "onWords={() => { setMode('recover'); setError(null); }}"],
        ['onCommunity', "onCommunity={() => { setError(null); router.push({ pathname: '/rekey-code', params: { bringBack: '1' } }); }}"],
        ['onRekey', "onRekey={() => { setError(null); router.push('/rekey-code'); }}"],
        ['onBrowser', "onBrowser={() => { setError(null); router.push('/pair-in'); }}"],
    ])('%s goes where its row says', (_name, wiring) => {
        expect(menu()).toContain(wiring);
    });

    it('Back from the ways back returns to the front door', () => {
        expect(menu()).toContain('onPress={goBack}');
        expect(slice('function goBack() {', '}')).toContain("setMode('home')");
    });

    it('"Start a new account instead" is under the five ways and above Back, where there is no account, and only opens the front door', () => {
        const m = menu();
        expect(m).toContain('{offersStartNew(!!accountOnPhone) && (');
        expect(m.indexOf('<RestoreMenu')).toBeLessThan(m.indexOf('<StartNewInstead'));
        expect(m.indexOf('<StartNewInstead')).toBeLessThan(m.indexOf('onPress={goBack}'));
        const startNew = slice('<StartNewInstead', '/>');
        expect(startNew).toContain("onStartNew={() => { setError(null); setMode('home'); }}");
        expect(startNew).not.toMatch(/handle\w*(Create|Join)|generate|createIdentity|setIdentity|setPendingIdentity/);
    });

    it('back from the 12 words and from the sign-in restore returns to the ways back', () => {
        const words = slice("if (mode === 'recover') {", "if (mode === 'ssoRecover'");
        expect(words).toContain("setMode('member')");
        const signIn = welcome.slice(welcome.indexOf("if (mode === 'ssoRecover'"), welcome.indexOf('// --- WAITING TO BE LET IN'));
        expect(signIn.match(/setMode\('member'\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });
});
