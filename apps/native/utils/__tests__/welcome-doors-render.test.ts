// @vitest-environment jsdom
/**
 * The first screen's two doors (components/WelcomeDoors.tsx, drawn by app/welcome.tsx's home; DESIGN-global-entry-fable.md
 * §B.3, decision 2), rendered for real in every state the global community's door can be in: not heard yet, open, no
 * answer (offline), shut, a private preview. In each, both buttons are there, Join with an invite first and Explore
 * BeanPool worldwide right under it, both work, TalkBack reads each by name and Explore's state with it, and the line
 * under Explore says why it can't be used right now. Before P2 the Explore button was drawn only after an "open" answer,
 * so offline, shut or in a preview it was simply not there (§1.2): global-door-offer.test.ts pins that its state no longer
 * hides anything, and this file that the screen draws both doors whatever it is.
 *
 * Then the fold: at 320 dp × 569 dp (a 480×854 phone at 240 dpi) with text at 1.3×, less the status and navigation bars,
 * both buttons are above it in every language, measured from the welcome screen's own style numbers, as
 * language-switch-render.test.ts measures its words. With the long sentence about BeanPool above them, as it was, Explore
 * fell under the fold in English: that is why it now comes after them.
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
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, accessibilityLiveRegion, disabled, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => { if (!disabled) onPress(); };
        if (disabled) attrs['data-disabled'] = 'true';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityLiveRegion) attrs['aria-live'] = accessibilityLiveRegion;
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

import { WelcomeDoors } from '../../components/WelcomeDoors';
import { LanguageProvider } from '../../components/LanguageProvider';
import { setLanguage, type UiLang } from '@beanpool/core';
import type { GlobalDoorState } from '../global-entry';

const STYLES = { homeDoors: {}, memberBtn: {}, memberBtnText: {}, doorLine: {}, inviteOnlyHint: {} };
const LINE: Record<GlobalDoorState, string | null> = {
    unknown: null,
    open: null,
    unreachable: "Can't reach the global community right now. Try again, or join with an invite.",
    closed: 'Not taking new members right now.',
    preview: 'This community is in a private preview. Ask its owner for an invite.',
};
const HINT = 'No invite? Explore BeanPool worldwide and find a community near you.';

let host: HTMLDivElement;
let root: Root;
const taps = { invite: 0, explore: 0 };
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    taps.invite = 0;
    taps.explore = 0;
    setLanguage('en');
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

async function draw(door: GlobalDoorState, initial?: UiLang): Promise<void> {
    const doors = createElement(WelcomeDoors, {
        door,
        joinWithInvite: () => { taps.invite++; },
        openGlobalDoor: () => { taps.explore++; },
        styles: STYLES,
    });
    await act(async () => {
        root.render((initial ? createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial }, doors) : doors) as any);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const buttons = () => Array.from(host.querySelectorAll('[role="button"]')) as HTMLElement[];
/** Everything a member reads, top to bottom. */
const reading = () => Array.from(host.querySelectorAll('span')).filter((s) => s.children.length === 0).map((s) => s.textContent ?? '');

describe('both doors, in order, in every state of the global community\'s door', () => {
    for (const door of ['unknown', 'open', 'unreachable', 'closed', 'preview'] as GlobalDoorState[]) {
        it(`${door}: Join with an invite, then Explore BeanPool worldwide, both working${LINE[door] ? ', and the line says why' : ''}`, async () => {
            await draw(door);
            const [invite, explore, ...more] = buttons();
            expect(more).toEqual([]);
            expect(invite.getAttribute('aria-label')).toBe('Join with an invite');
            expect(invite.textContent).toBe('🎟️ Join with an invite');
            expect(explore.getAttribute('aria-label')).toBe('Explore BeanPool worldwide');
            expect(explore.textContent).toBe('🌍 Explore BeanPool worldwide');
            // Invite first: drawn before Explore, as a screen reader meets them.
            expect(invite.compareDocumentPosition(explore) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            // Never a gate: both are live whatever the door said (the door asks again fresh when Explore is tapped).
            for (const b of [invite, explore]) expect(b.getAttribute('data-disabled')).toBeNull();
            await act(async () => { invite.click(); explore.click(); });
            expect(taps).toEqual({ invite: 1, explore: 1 });
            // What is read, in order: the two buttons, the state's line if any, then the hint.
            expect(reading()).toEqual(['🎟️ Join with an invite', '🌍 Explore BeanPool worldwide', ...(LINE[door] ? [LINE[door]!] : []), HINT]);
            // TalkBack reads the state with the button, and announces the line when it appears.
            expect(explore.getAttribute('data-hint')).toBe(LINE[door]);
            const line = Array.from(host.querySelectorAll('span[aria-live="polite"]'));
            expect(line.map((s) => s.textContent)).toEqual(LINE[door] ? [LINE[door]] : []);
        });
    }

    it('each button\'s label takes at most two lines, shrinking first (one line in English)', async () => {
        await draw('unreachable');
        for (const b of buttons()) expect(b.querySelector('span')!.getAttribute('data-lines')).toBe('2');
        // The state's line is never cut.
        expect(host.querySelector('span[aria-live="polite"]')!.getAttribute('data-lines')).toBeNull();
    });

    it('every word is through t(): in the pseudo-locale everything on the doors is its translation', async () => {
        for (const door of ['unreachable', 'closed', 'preview'] as GlobalDoorState[]) {
            await draw(door, 'xx');
            for (const piece of reading()) expect(piece, `"${piece}" bypassed t()`).toMatch(/^\[.*\]$/s);
            for (const b of buttons()) expect(b.getAttribute('aria-label')).toMatch(/^\[.*\]$/s);
            expect(buttons()[1].getAttribute('data-hint')).toMatch(/^\[.*\]$/s);
        }
    });
});

describe('above the fold at 320 dp with text at 1.3×', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');
    const welcome = read('app/welcome.tsx');
    const picker = read('components/LanguagePicker.tsx');
    const style = (src: string, name: string) => {
        const m = src.match(new RegExp(`\\n\\s*${name}: \\{([^}]*)\\}`));
        expect(m, name).not.toBeNull();
        return (prop: string) => {
            const v = m![1].match(new RegExp(`\\b${prop}: (\\d+)`));
            return v ? Number(v[1]) : 0;
        };
    };
    const SCREEN = { width: 320, height: 569 };
    // Android's status bar and three-button navigation bar: what is left for the screen.
    const VISIBLE = SCREEN.height - 24 - 48;
    const FONT_SCALE = 1.3;
    // A line box of 1.2 em (Roboto's is about 1.17).
    const lineBox = (fontSize: number) => fontSize * FONT_SCALE * 1.2;
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
    const em = (c: string) => (/\p{M}/u.test(c) ? 0 : /[️‌‍]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : CJK.test(c) ? 1 : 0.62);
    const widthOf = (s: string, size: number) => Array.from(s).reduce((w, c) => w + em(c) * size * FONT_SCALE, 0);
    /** Lines a text takes, wrapped word by word (character by character in CJK), at the generous glyph widths above. */
    const linesOf = (text: string, size: number, width: number) => {
        const pieces = text.split(/(\s+)/).flatMap((w) => (CJK.test(w) ? Array.from(w) : [w])).filter((w) => w.length > 0);
        let lines = 1;
        let at = 0;
        for (const p of pieces) {
            const w = widthOf(p, size);
            if (/^\s+$/.test(p)) { at += w; continue; }
            if (at > 0 && at + w > width) { lines++; at = w; } else at += w;
        }
        return lines;
    };
    const content = style(welcome, 'homeContent');
    const title = style(welcome, 'headerTitle');
    const doors = style(welcome, 'homeDoors');
    const btn = style(welcome, 'memberBtn');
    const btnText = style(welcome, 'memberBtnText');
    const about = style(welcome, 'homeAbout');
    const sw = style(picker, 'switch');
    const COLUMN = SCREEN.width - 2 * content('padding');
    const BUTTON_LINE = COLUMN - 2 * btn('paddingHorizontal');
    const button = (label: string) => 2 * btn('paddingVertical') + Math.min(2, linesOf(label, btnText('fontSize'), BUTTON_LINE)) * lineBox(btnText('fontSize'));

    /** Where Explore's bottom edge is, from the top of the screen's content, with these words. */
    function exploreBottom(words: { title: string; invite: string; explore: string }, aboutAbove?: string): number {
        let y = content('padding');
        y += sw('minHeight') + sw('marginBottom');
        y += linesOf(words.title, title('fontSize'), COLUMN) * lineBox(title('fontSize')) + title('marginBottom');
        if (aboutAbove) y += linesOf(aboutAbove, about('fontSize'), COLUMN) * about('lineHeight') * FONT_SCALE + 32;
        y += doors('marginTop');
        y += button(words.invite) + btn('marginBottom');
        y += button(words.explore);
        return y;
    }

    it('the home draws the switch, the title, then the doors: nothing else between them', () => {
        const home = welcome.slice(welcome.indexOf('// --- MAIN WELCOME SCREEN ---'), welcome.indexOf('function makeStyles('));
        const code = home.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
        const between = code.slice(code.indexOf('<LanguageSwitch />'), code.indexOf('<WelcomeDoors '));
        expect(between.match(/<[A-Z][A-Za-z.]*/g)).toEqual(['<LanguageSwitch', '<Text']);
        expect(between).toContain("{t('Welcome to BeanPool')}");
        expect(content('padding')).toBe(24);
    });

    const NATIVE_WORDS = path.resolve(__dirname, '../../words');
    const LANGS = ['en', 'xx', ...fs.readdirSync(NATIVE_WORDS).filter((f) => /^[A-Za-z-]+\.json$/.test(f)).map((f) => f.slice(0, -5))];
    for (const lang of LANGS) {
        it(`${lang}: both buttons end above the fold`, async () => {
            const { pseudoLocalise } = await import('@beanpool/core');
            const cat = lang === 'en' || lang === 'xx' ? {} : JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, `${lang}.json`), 'utf8')) as Record<string, string>;
            const say = (k: string) => (lang === 'en' ? k : lang === 'xx' ? pseudoLocalise(k) : cat[k]);
            const words = { title: say('Welcome to BeanPool'), invite: say('🎟️ Join with an invite'), explore: say('🌍 Explore BeanPool worldwide') };
            for (const w of Object.values(words)) expect(typeof w).toBe('string');
            expect(exploreBottom(words), JSON.stringify(words)).toBeLessThanOrEqual(VISIBLE);
        });
    }

    it('with the sentence about BeanPool above the doors (as before P2), Explore fell under the fold in English', () => {
        const sentence = 'Trade skills, goods and favours with your local community — no bank, no fees. Your account lives safely on this device: no passwords, no emails, nothing to remember.';
        expect(welcome).toContain(`{t('${sentence}')}`);
        const english = { title: 'Welcome to BeanPool', invite: '🎟️ Join with an invite', explore: '🌍 Explore BeanPool worldwide' };
        expect(exploreBottom(english)).toBeLessThanOrEqual(VISIBLE);
        expect(exploreBottom(english, sentence)).toBeGreaterThan(VISIBLE);
    });
});
