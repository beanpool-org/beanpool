// @vitest-environment jsdom
/**
 * The front door (components/welcome/FrontDoor.tsx, drawn by app/welcome.tsx's home; DESIGN-onboarding-home-landing-fable.md
 * §3.1 A, slice S1, with the iPhone tile of DESIGN-ios-invite-paste-fable.md §4.1; Marty, 21 Nov 2026: "Yes, all of Fable's
 * picks"). It replaces "Used BeanPool before?" and the doors (components/welcome/UsedBefore.tsx, components/WelcomeDoors.tsx,
 * both gone with their tests).
 *
 * Rendered for real in every state the global community's door can be in: the colour block's mark and line, then I have an
 * invite, No invite? Look around and I've used BeanPool before, in that order, each working, Look around's line saying why
 * it can't be used right now (as the doors' did); More ways in › opens the sheet with Ask a community to join and Claim a
 * server you installed. The iPhone tile: our words over Apple's icon-only button, Tap to open it, Scan or type it instead.
 * In the pseudo-locale every word is through t() but the mark, which is never translated.
 *
 * Then the arrival rules (utils/invite-arrival.ts) as a table, the screen's wiring read from its source (the source guard: no
 * clipboard read of ours on iOS 16+ outside Apple's button), "Start a new account instead", and the fold at 320 dp × 1.3.
 * The whole-screen arrivals (which screen, which button, no read before a tap, a non-invite never shown or sent) are rendered
 * in welcome-invite-post-render.test.ts §5.
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

const apple = vi.hoisted(() => ({ props: [] as Array<Record<string, any>> }));
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, accessibilityLiveRegion, disabled, testID, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); if (!disabled) onPress({ stopPropagation() {} }); };
        if (disabled) attrs['data-disabled'] = 'true';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityLiveRegion) attrs['aria-live'] = accessibilityLiveRegion;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (accessibilityRole === 'header') attrs['data-header'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
    };
});
vi.mock('expo-clipboard', () => ({
    isPasteButtonAvailable: true,
    getStringAsync: vi.fn(async () => { throw new Error('the front door never reads the clipboard itself'); }),
    ClipboardPasteButton: (props: Record<string, any>) => {
        apple.props.push(props);
        return createElement('button', { 'data-testid': 'apple-paste', onClick: () => props.onPress({ type: 'text', text: 'pasted' }) });
    },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));

import { FrontDoor } from '../../components/welcome/FrontDoor';
import { StartNewInstead } from '../../components/welcome/StartNewInstead';
import { LanguageProvider } from '../../components/LanguageProvider';
import { brandColours, setLanguage, type UiLang } from '@beanpool/core';
import type { GlobalDoorState } from '../global-entry';
import { homeView, offersStartNew } from '../first-question';
import { inviteDoor, inviteOnly, ourButtonReadsClipboard } from '../invite-arrival';
import { onboardingColors } from '../onboarding-colors';

const LINE: Record<GlobalDoorState, string | null> = {
    unknown: null,
    open: null,
    unreachable: "Can't reach the global community right now. Try again, or join with an invite.",
    closed: 'Not taking new members right now.',
    preview: 'This community is in a private preview. Ask its owner for an invite.',
};
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');
const welcome = read('app/welcome.tsx');
const doorSource = read('components/welcome/FrontDoor.tsx');

let host: HTMLDivElement;
let root: Root;
let taps: string[] = [];
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    taps = [];
    apple.props.length = 0;
    setLanguage('en');
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

async function draw(opts: { door?: GlobalDoorState; appleTile?: boolean; exploring?: boolean; lang?: UiLang; dark?: boolean } = {}): Promise<void> {
    const node = createElement(FrontDoor, {
        colors: onboardingColors(opts.dark ? 'dark' : 'light').colors,
        door: opts.door ?? 'unknown',
        exploring: opts.exploring ?? false,
        appleTile: opts.appleTile ?? false,
        onInvite: () => { taps.push('invite'); },
        onApplePaste: (text: string) => { taps.push(`apple:${text}`); },
        onScanOrType: () => { taps.push('scanOrType'); },
        onLookAround: () => { taps.push('lookAround'); },
        onUsedBefore: () => { taps.push('usedBefore'); },
        onAskToJoin: () => { taps.push('askToJoin'); },
        onClaim: () => { taps.push('claim'); },
    });
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: opts.lang ?? 'en' }, node) as any); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const buttons = () => Array.from(host.querySelectorAll('[role="button"]')) as HTMLElement[];
/** Everything a member reads, top to bottom. */
const reading = () => Array.from(host.querySelectorAll('span')).filter((s) => s.children.length === 0).map((s) => s.textContent ?? '');
const click = async (el: HTMLElement | null) => { expect(el).toBeTruthy(); await act(async () => { el!.click(); }); };

describe('the front door, in every state of the global community\'s door', () => {
    for (const door of ['unknown', 'open', 'unreachable', 'closed', 'preview'] as GlobalDoorState[]) {
        it(`${door}: the mark and its line, then I have an invite, Look around, I've used BeanPool before, More ways in, all working${LINE[door] ? ', and the line says why' : ''}`, async () => {
            await draw({ door });
            expect(reading()).toEqual([
                'BeanPool',
                'Trade skills, goods and favours with your neighbours.',
                'I have an invite',
                'No invite? Look around',
                ...(LINE[door] ? [LINE[door]!] : []),
                "I've used BeanPool before",
                'More ways in ›',
            ]);
            expect(host.querySelector('[data-header="true"]')?.textContent).toBe('BeanPool');
            const [invite, look, used, more, ...rest] = buttons();
            expect(rest).toEqual([]);
            // Never a gate: all live whatever the door said (Look around asks again fresh when tapped).
            for (const b of [invite, look, used, more]) expect(b.getAttribute('data-disabled')).toBeNull();
            // Words that wrap: no line limit anywhere on the door.
            expect(host.querySelector('[data-lines]')).toBeNull();
            // TalkBack reads Look around's state with it, and announces the line when it appears.
            expect(look.getAttribute('data-hint')).toBe(LINE[door]);
            expect(Array.from(host.querySelectorAll('span[aria-live="polite"]')).map((s) => s.textContent)).toEqual(LINE[door] ? [LINE[door]] : []);
            await click(invite); await click(look); await click(used);
            expect(taps).toEqual(['invite', 'lookAround', 'usedBefore']);
            // The sheet is closed until More ways in is tapped.
            expect(byId('front-door-more-sheet')).toBeNull();
        });
    }

    it('Look around while it asks: the line says so, and a second tap waits; the other buttons still work', async () => {
        await draw({ exploring: true });
        expect(reading()).toContain('Connecting to the global community…');
        await click(byId('front-door-look-around'));
        expect(taps).toEqual([]);
        await click(byId('front-door-invite'));
        expect(taps).toEqual(['invite']);
    });

    it('More ways in ›: a sheet with Ask a community to join and Claim a server you installed, each going where it says', async () => {
        await draw();
        await click(byId('front-door-more'));
        const sheet = byId('front-door-more-sheet')!;
        expect(Array.from(sheet.querySelectorAll('span')).map((s) => s.textContent)).toEqual(['Ask a community to join', 'Claim a server you installed', 'Cancel']);
        await click(byId('welcome-ask-to-join'));
        expect(taps).toEqual(['askToJoin']);
        expect(byId('front-door-more-sheet')).toBeNull();
        await click(byId('front-door-more'));
        await click(byId('welcome-claim-server'));
        expect(taps).toEqual(['askToJoin', 'claim']);
        await click(byId('front-door-more'));
        await click(buttons().find((b) => b.textContent === 'Cancel')!);
        expect(byId('front-door-more-sheet')).toBeNull();
        expect(taps).toEqual(['askToJoin', 'claim']);
    });

    it('in the pseudo-locale every word is through t(), but the mark, which is never translated', async () => {
        for (const door of ['unreachable', 'closed', 'preview'] as GlobalDoorState[]) {
            await draw({ door, lang: 'xx' });
            for (const piece of reading().filter((p) => p !== 'BeanPool')) expect(piece, `"${piece}" bypassed t()`).toMatch(/^\[.*\]$/s);
            expect(byId('front-door-look-around')!.getAttribute('data-hint')).toMatch(/^\[.*\]$/s);
        }
        await draw({ appleTile: true, lang: 'xx' });
        for (const piece of reading().filter((p) => p !== 'BeanPool')) expect(piece, `"${piece}" bypassed t()`).toMatch(/^\[.*\]$/s);
    });

    it('light and dark: the block and the buttons are the central tokens, the block the same fill in both', async () => {
        for (const dark of [false, true]) {
            const { colors } = onboardingColors(dark ? 'dark' : 'light');
            expect(colors.brand.fill).toBe(brandColours('light').commit.fill);
            expect(colors.action.cta).toBe(brandColours('light').cta.fill);
            expect(colors.text.onBrand).toBe(brandColours('light').commit.on);
            await draw({ dark });
            expect(byId('front-door')).toBeTruthy();
        }
        // No colour of its own: every colour in the component comes from the token tree or core's brand colours.
        expect(doorSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|palette\./);
    });
});

describe('the iPhone invite tile (iOS 16 and later, text copied)', () => {
    it('our words over Apple\'s own button, icon only, in the call to action\'s colours; Tap to open it; Scan or type it instead', async () => {
        await draw({ appleTile: true });
        expect(byId('front-door-invite')).toBeNull();
        expect(reading()).toEqual([
            'BeanPool',
            'Trade skills, goods and favours with your neighbours.',
            'I have an invite',
            'Tap to open it',
            'Scan or type it instead ›',
            'No invite? Look around',
            "I've used BeanPool before",
            'More ways in ›',
        ]);
        const props = apple.props.at(-1)!;
        expect(props.displayMode).toBe('iconOnly');
        expect(props.cornerStyle).toBe('large');
        expect(props.backgroundColor).toBe(brandColours('light').cta.fill);
        expect(props.foregroundColor).toBe(brandColours('light').cta.on);
        expect(props.acceptedContentTypes).toEqual(['plain-text', 'url']);
        // Full width, 52 dp, and nothing drawn over it: it has no children and sits in the tile's column.
        expect(props.style).toEqual({ width: '100%', height: 52 });
        expect(props.children).toBeUndefined();
        await click(byId('apple-paste'));
        await click(byId('front-door-scan-or-type'));
        expect(taps).toEqual(['apple:pasted', 'scanOrType']);
    });

    it('what Apple\'s button hands over that is not text (a picture) is not taken', async () => {
        await draw({ appleTile: true });
        await act(async () => { apple.props.at(-1)!.onPress({ type: 'image', data: 'x', size: { width: 1, height: 1 } }); });
        expect(taps).toEqual([]);
    });
});

describe('which invite affordance, and who may read (utils/invite-arrival.ts)', () => {
    it.each([
        // [phone, Apple's button exists, text copied, the door draws, our button reads at its tap]
        ['android', false, true, 'our-button', true],
        ['android', false, false, 'our-button', true],
        ['ios', true, true, 'apple-tile', false],
        ['ios', true, false, 'our-button', false],
        ['ios', false, true, 'our-button', true],
        ['ios', false, false, 'our-button', true],
        ['web', false, true, 'our-button', false],
    ] as const)('%s, Apple button %s, copied %s: %s; our button reads: %s', (os, pasteButton, copiedText, door, reads) => {
        expect(inviteDoor({ os, pasteButton, copiedText })).toBe(door);
        expect(ourButtonReadsClipboard({ os, pasteButton })).toBe(reads);
    });

    it.each([
        ['https://riverside.example/?invite=INV-ABCD-EFGH', true],
        ['  INV-ABCD-EFGH  ', true],
        ['Join me on BeanPool! https://riverside.example/?invite=INV-ABCD-EFGH', true],
        ['milk, eggs, bread', false],
        ['', false],
        ['https://example.com/a-page', false],
    ])('a tap brought "%s": kept only if it is an invite (%s)', (raw, kept) => {
        expect(inviteOnly(raw)).toBe(kept ? raw.trim() : null);
    });
    it('anything but text is never kept', () => {
        for (const raw of [null, undefined, 42, { invite: 'INV-ABCD-EFGH' }]) expect(inviteOnly(raw)).toBeNull();
    });
});

describe('which first screen the home draws (utils/first-question.ts)', () => {
    it.each([
        // [has an account, waiting to be let in, view]
        [false, false, 'door'],
        // A wait without an account can't happen; the front door if it ever did.
        [false, true, 'door'],
        [true, true, 'waiting'],
        [true, false, 'door'],
    ] as const)('account %s, waiting %s: %s', (hasAccount, waiting, view) => {
        expect(homeView({ hasAccount, waiting })).toBe(view);
    });

    it('"Start a new account instead" only where there is no account on this phone', () => {
        expect(offersStartNew(false)).toBe(true);
        expect(offersStartNew(true)).toBe(false);
    });
});

describe('"Start a new account instead": never a dead end, and plain about what it does', () => {
    it('says it makes a new account, and its tap only calls back', async () => {
        let started = 0;
        const node = createElement(StartNewInstead, { ...onboardingColors('light'), onStartNew: () => { started++; } });
        await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, node) as any); });
        expect(reading()).toEqual([
            "Can't bring your account back? You can start again, but that makes a new account. Your old account stays as it is, and the two can never be joined into one.",
            'Start a new account instead →',
        ]);
        await click(buttons()[0]);
        expect(started).toBe(1);
    });
});

describe('the welcome screen\'s wiring (app/welcome.tsx)', () => {
    /** The body of welcome.tsx from `start` up to the first `end` after it. */
    function slice(start: string, end: string): string {
        const at = welcome.indexOf(start);
        expect(at, `welcome.tsx has ${start}`).toBeGreaterThan(-1);
        const stop = welcome.indexOf(end, at);
        expect(stop, `welcome.tsx has ${end} after ${start}`).toBeGreaterThan(at);
        return welcome.slice(at, stop);
    }
    /** Code only: what a comment says is not code. */
    const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

    it('the source guard: no read of the clipboard by any button of ours on iOS 16+, only Apple\'s button hands text over', () => {
        const src = code(welcome) + code(doorSource);
        // One read of ours in the whole screen and its door: inside "I have an invite", behind the rule that says no on iOS 16+.
        expect(src.match(/Clipboard\.getStringAsync\(/g)).toHaveLength(1);
        const tap = slice('async function handleInviteTap', 'function handleInviteNext');
        expect(tap).toMatch(/ourButtonReadsClipboard\(\{ os: Platform\.OS, pasteButton: Clipboard\.isPasteButtonAvailable \}\)\) \{\s*const invite = inviteOnly\(await Clipboard\.getStringAsync\(\)/);
        // Apple's buttons (the tile and the box's) hand their text to takeInvite, which keeps only an invite.
        expect(src.match(/<Clipboard\.ClipboardPasteButton/g)).toHaveLength(2);
        for (const at of [welcome.indexOf('<Clipboard.ClipboardPasteButton'), doorSource.indexOf('<Clipboard.ClipboardPasteButton')]) expect(at).toBeGreaterThan(-1);
        expect(welcome).toMatch(/onPress=\{\(data\) => \{ if \(data\.type === 'text'\) void takeInvite\(data\.text\); \}\}/);
        expect(welcome).toMatch(/onApplePaste=\{\(text\) => \{ setError\(null\); void takeInvite\(text\); \}\}/);
        const take = slice('async function takeInvite', 'async function handleInviteTap');
        expect(take).toMatch(/const invite = inviteOnly\(raw\);/);
        // A non-invite is never put in a box or state: only the line is set.
        expect(take).not.toMatch(/setInviteDraft|setInviteCode|setCallsign/);
        // Only presence is asked before a tap, and only where Apple's button exists.
        expect(slice('// The invite page copies the invite link', 'async function takeInvite')).toMatch(/if \(!Clipboard\.isPasteButtonAvailable \|\| \(mode !== 'home' && mode !== 'create'\)\) return;/);
    });

    it('the front door is drawn on the home whenever there is no waiting account, the language switch first', () => {
        const door = slice('// --- THE FRONT DOOR', 'function makeStyles');
        expect(door.indexOf('<LanguageSwitch />')).toBeLessThan(door.indexOf('<FrontDoor'));
        expect(welcome.indexOf('// --- WAITING TO BE LET IN')).toBeLessThan(welcome.indexOf('// --- THE FRONT DOOR'));
        // Nothing on the door makes a key or joins: those wait for a way in the person chooses.
        const tag = slice('<FrontDoor', '/>');
        expect(tag).not.toMatch(/handle\w*(Create|Join)|generate|createIdentity|setIdentity|setPendingIdentity/);
        expect(tag).toContain("onUsedBefore={() => { setError(null); setMode('member'); }}");
        expect(tag).toContain("onAskToJoin={() => router.push('/find-community')}");
    });

    it('Your invite only when no invite was found; the name screen greeted otherwise, with the pencil back to Your invite', () => {
        expect(welcome).toContain("if (mode === 'create' && !inviteCode.trim()) {");
        const invite = slice("if (mode === 'create' && !inviteCode.trim()) {", "if (mode === 'create') {");
        for (const words of ["{t('Your invite')}", "{t('Scan a QR code')}", "placeholder={t('Invite link or code')}", "{t('Have the link? Tap it again.')}"]) expect(invite).toContain(words);
        expect(invite).toContain('onPress={handleInviteNext}');
        // The name screen has no invite box, and no paste of any kind.
        const name = slice("if (mode === 'create') {", "// --- THE GLOBAL COMMUNITY'S DOOR");
        expect(name).not.toContain("placeholder={t('Invite link or code')}");
        expect(name).not.toMatch(/Clipboard|Paste/);
        expect(name).toContain('testID="invite-greeting-change"');
        expect(name).toContain("setInviteDraft(inviteCode); setInviteCode('')");
    });

    it('"Start a new account instead" is under the ways back where there is no account, and only opens the front door', () => {
        const menu = slice("if (mode === 'member') {", '// --- RECOVER FROM 12 WORDS ---');
        expect(menu).toContain('{offersStartNew(!!accountOnPhone) && (');
        const startNew = slice('<StartNewInstead', '/>');
        expect(startNew).toContain("onStartNew={() => { setError(null); setMode('home'); }}");
        expect(startNew).not.toMatch(/handle\w*(Create|Join)|generate|createIdentity|setIdentity|setPendingIdentity/);
    });
});

describe('text at 1.3×: the invite is above the fold in every language, on the smallest phone that draws it', () => {
    const picker = read('components/LanguagePicker.tsx');
    const style = (src: string, name: string) => {
        const m = src.match(new RegExp(`\\n\\s*${name}: \\{([^}]*)\\}`));
        expect(m, name).not.toBeNull();
        return (prop: string) => {
            const v = m![1].match(new RegExp(`\\b${prop}: (-?\\d+)`));
            return v ? Number(v[1]) : 0;
        };
    };
    // Our button: Android's smallest, 320 × 569 dp, less its status bar and three-button navigation bar (and an iPhone on
    // iOS 15: the iPhone SE's 320 × 568 pt, less its 20 pt status bar, has more room than that).
    const ANDROID = { width: 320, visible: 569 - 24 - 48 };
    // Apple's button needs iOS 16, whose smallest iPhone is the iPhone 8 / SE (2nd and 3rd), 375 × 667 pt, less its status bar.
    const IOS16 = { width: 375, visible: 667 - 20 };
    const FONT_SCALE = 1.3;
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
    const em = (c: string) => (/\p{M}/u.test(c) ? 0 : /[️‌‍]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : CJK.test(c) ? 1 : 0.62);
    const widthOf = (s: string, size: number) => Array.from(s).reduce((w, c) => w + em(c) * size * FONT_SCALE, 0);
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
    const sw = style(picker, 'switch');
    const block = style(doorSource, 'block');
    const name = style(doorSource, 'name');
    const line = style(doorSource, 'line');
    const main = style(doorSource, 'mainBtn');
    const tileTitle = style(doorSource, 'tileTitle');
    const column = (width: number) => width - 2 * content('padding');
    const words = (lang: string): Record<string, string> => (lang === 'en' ? {} : JSON.parse(read(`words/${lang}.json`)));
    const LANGS = ['en', ...fs.readdirSync(path.resolve(__dirname, '../../words')).filter((f) => /^[A-Za-z-]+\.json$/.test(f)).map((f) => f.slice(0, -5))];

    /** Where the colour block ends, from the top of the screen's content. */
    function blockBottom(tagline: string, width: number): number {
        let y = content('padding') + sw('minHeight') + sw('marginBottom');
        y += block('paddingTop') + name('fontSize') * FONT_SCALE * 1.2 + name('marginBottom');
        y += linesOf(tagline, line('fontSize'), column(width) - 2 * block('paddingHorizontal')) * line('lineHeight') * FONT_SCALE;
        return y + block('paddingBottom') + block('marginBottom');
    }

    for (const lang of LANGS) {
        it(`${lang}: I have an invite (our button, or Apple's in the tile) ends above the fold`, () => {
            const w = words(lang);
            const tagline = w['Trade skills, goods and favours with your neighbours.'] ?? 'Trade skills, goods and favours with your neighbours.';
            expect(blockBottom(tagline, ANDROID.width) + main('minHeight'), `our button in ${lang}`).toBeLessThanOrEqual(ANDROID.visible);
            const title = w['I have an invite'] ?? 'I have an invite';
            const tile = blockBottom(tagline, IOS16.width) + linesOf(title, tileTitle('fontSize'), column(IOS16.width)) * tileTitle('fontSize') * FONT_SCALE * 1.2 + tileTitle('marginBottom') + 52;
            expect(tile, `Apple's button in ${lang}`).toBeLessThanOrEqual(IOS16.visible);
        });
    }
});
