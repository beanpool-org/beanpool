// @vitest-environment jsdom
/**
 * The screens Settings opens, in the member's language (words slice S3, sweep B4): profile setup (app/profile-setup.tsx)
 * with what only it draws, drawn for real: its "How BeanPool works" cards (components/OnboardingGuide.tsx), the Profile
 * Photo sheet (components/AvatarPickerSheet.tsx, which the first screen's wizard draws too: taken whole here) and the
 * area step (components/AreaPicker.tsx); Settings → Your area (app/your-area.tsx); Suggest a change
 * (app/suggest-change.tsx, with core's feedback.ts lines). Each is rendered inside the real LanguageProvider, with React
 * Native's host components as plain tags carrying their accessibility props, placeholders and the layout props the
 * 320 dp checks read. The community, the camera, the location and the project's feedback address are stubbed.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint,
 * placeholder or alert with letters outside a bracket bypassed t(). What members wrote is shown as written (a name, the
 * names offered in its place, a town), and so is the community's own refusal.
 *
 * Shared with other screens, so drawn as stand-ins here: MemberAvatar (the photo itself) and the town search
 * (components/AddressSearch, the event form's too), which draws the words the area step hands it, so those are checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
// The bundled avatars' images: utils/bundled-avatars.ts require()s them as it loads, so before the screens are imported.
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
});
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', radiogroup: 'radiogroup' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, onLayout, onContentSizeChange, value, onChangeText, disabled } = props;
        useEffect(() => {
            onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 40 } } });
            // A strip wider than the sheet: the "more avatars" cue shows.
            onContentSizeChange?.(2000, 100);
        }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        const s = flat(props.style);
        if (s.flexDirection === 'row') attrs['data-row'] = 'true';
        if (s.flex !== undefined) attrs['data-flex'] = String(s.flex);
        if (typeof s.flexShrink === 'number' && s.flexShrink > 0) attrs['data-flex-shrink'] = String(s.flexShrink);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        if (s.textTransform) attrs['data-transform'] = s.textTransform;
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), SafeAreaView: el('div'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                for (const b of buttons ?? []) if (b.text) alerts.said.push(b.text);
            },
        },
        Keyboard: { addListener: listener, dismiss() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, back: 0 }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, replace() {}, navigate() {}, back: () => { nav.back++; }, canGoBack: () => true },
        useLocalSearchParams: () => nav.params,
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        ErrorBoundary: () => null,
    };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Sally' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: IDENTITY, setIdentity() {} }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx), useOnboardingColors: () => onboardingColors('light') };
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return { KeyboardAwareScrollView: pass, KeyboardStickyView: pass };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
vi.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: async () => ({ granted: false }),
    launchCameraAsync: async () => ({ canceled: true, assets: [] }),
    launchImageLibraryAsync: async () => { throw new Error('no gallery here'); },
}));
vi.mock('../image-processing', () => ({ processProfileImage: async () => null }));
// Shared with other screens: stand-ins (see the note above). The town search draws the words it is handed.
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
const BYRON = { displayName: 'Byron Bay, New South Wales, Australia', shortName: 'Byron Bay', lat: -28.647412, lng: 153.612031, type: 'town' };
vi.mock('../../components/AddressSearch', () => ({
    AddressSearch: ({ onPick, words }: { onPick: (r: typeof BYRON) => void; words: { label: string; placeholder: string; source: string } }) => createElement('div', null,
        createElement('input', { 'aria-label': words.label, placeholder: words.placeholder }),
        createElement('span', null, words.source),
        createElement('button', { 'data-testid': 'pick-byron', onClick: () => onPick(BYRON) })),
}));
const prof = vi.hoisted(() => ({ value: null as any }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => prof.value }));
vi.mock('../identity', () => ({ updateCallsign: async () => null }));
vi.mock('../db', () => ({ getMemberProfile: async () => ({ avatar_url: '/api/avatar/aaa?size=thumb' }), updateMemberProfile: async () => undefined }));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: async () => null }));
const names = vi.hoisted(() => ({ status: 'available' as string, suggestions: [] as string[] }));
vi.mock('../callsign-suggest', () => ({ checkCallsignAvailable: async () => names.status, suggestCallsigns: async () => names.suggestions }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('expo-location', () => ({
    Accuracy: { Low: 2 },
    getForegroundPermissionsAsync: async () => ({ status: 'denied' }),
    requestForegroundPermissionsAsync: async () => ({ status: 'denied' }),
    getCurrentPositionAsync: async () => ({ coords: { latitude: 0, longitude: 0 } }),
}));

import { FEEDBACK_ENDPOINT, pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider, DrawnInLanguage } from '../../components/LanguageProvider';
import { LanguagePickerSheet } from '../../components/LanguagePicker';
import { areaSaveFailureWords } from '../../components/AreaPicker';
import { writeMemberArea } from '../member-area';
import ProfileSetupScreen from '../../app/profile-setup';
import YourAreaScreen from '../../app/your-area';
import SuggestChangeScreen from '../../app/suggest-change';

const NODE = 'https://mullum.example';
const GLOBAL_FEATURES = { openJoin: true, beans: false, nearbyListings: { radiusKm: 250, max: 500 } };
const LOCAL_FEATURES = { beans: true, invites: true };

/** What members and the community wrote, shown as written: names, the names offered instead, a town, a refusal. */
const OTHERS = ['Sally', 'Sally2', 'Sal', 'Byron Bay', 'Wren', 'Mullum Commons', 'The node is busy.'].sort((a, b) => b.length - a.length);

let host: HTMLDivElement;
let root: Root;
type Answer = { status: number; body: unknown } | 'offline';
let answers: Record<string, Answer> = {};
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    nav.params = {};
    nav.back = 0;
    alerts.said.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    names.status = 'available';
    names.suggestions = [];
    prof.value = { profile: 'local', features: LOCAL_FEATURES, checkedAt: new Date().toISOString() };
    answers = {};
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        const hit = Object.entries(answers).find(([part]) => u.includes(part))?.[1];
        if (hit === 'offline' || !hit) throw new TypeError('offline');
        return { ok: hit.status < 400, status: hit.status, json: async () => hit.body } as unknown as Response;
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, screen: () => unknown) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(screen as any)) as any); });
    await settle();
}
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const type = async (el: Element | null | undefined, text: string) => {
    expect(el).toBeTruthy();
    const input = el as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};
/** The button whose words include `english`, as drawn in `lang` (xx: bracketed). */
const button = (english: string, lang: UiLang = 'xx') => {
    const shown = lang === 'xx' ? pseudoLocalise(english) : english;
    return Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(shown)) ?? null;
};
const byLabel = (english: string) => host.querySelector(`[aria-label="${pseudoLocalise(english).replace(/"/g, '\\"')}"]`);
/** The name step's check waits 400 ms after typing. */
const afterTheNameCheck = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 450)); }); await settle(); };

/** Text with letters outside a pseudo-locale bracket, once what others wrote is taken out. */
function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const o of OTHERS) rest = rest.split(o).join('');
    return /\p{L}/u.test(rest);
}
/** Every drawn text, label, hint, placeholder and alert that bypassed t(). */
function bypassing(): string[] {
    const out = new Set<string>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const whole = n.parentElement?.textContent ?? n.nodeValue;
        if (outsideBrackets(whole)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const [attr, kind] of [['aria-label', 'label'], ['data-hint', 'hint'], ['placeholder', 'placeholder']] as const) {
        for (const e of Array.from(host.querySelectorAll(`[${attr}]`))) {
            const v = e.getAttribute(attr);
            if (outsideBrackets(v)) out.add(`${kind}: ${JSON.stringify(v)}`);
        }
    }
    for (const said of alerts.said) if (outsideBrackets(said)) out.add(`alert: ${JSON.stringify(said)}`);
    return [...out];
}
const bracketed = () => Array.from(host.querySelectorAll('span')).filter((s) => /^\[.*\]$/su.test(s.textContent ?? '')).length;

describe('profile setup in the pseudo-locale: every word came through t() (words S3e)', () => {
    it('the name step: the step count, the field, each answer of the name check, the names offered instead', async () => {
        await renderIn('xx', ProfileSetupScreen);
        await afterTheNameCheck();
        expect(host.textContent).toContain(pseudoLocalise('Step {n} of {total}').replace('{n}', '1').replace('{total}', '3'));
        expect(host.textContent).toContain(pseudoLocalise('👋 Your name'));
        expect(host.textContent).toContain(pseudoLocalise('✓ Available on this community'));
        expect(byLabel('Your callsign')).not.toBeNull();
        expect(bypassing(), 'available').toEqual([]);

        names.status = 'taken';
        names.suggestions = ['Sally2', 'Sal'];
        await type(host.querySelector('input'), 'Wren');
        await afterTheNameCheck();
        expect(host.textContent).toContain(pseudoLocalise("✗ That name's taken here. Pick one of these, or edit your own:"));
        expect(byLabel('Use the name {name}')).toBeNull();
        expect(host.querySelector(`[aria-label="${pseudoLocalise('Use the name {name}').replace('{name}', 'Sally2')}"]`)).not.toBeNull();
        expect(bypassing(), 'taken').toEqual([]);

        names.status = 'unknown';
        await type(host.querySelector('input'), 'Wrenna');
        await afterTheNameCheck();
        expect(host.textContent).toContain(pseudoLocalise("Couldn't check right now — you can still continue."));
        expect(bypassing(), 'unknown').toEqual([]);
    });

    it('the photo step and the Profile Photo sheet: its two sources, their refusals, the avatars and their names, the footer', async () => {
        nav.params = { name: 'Sally' };
        await renderIn('xx', ProfileSetupScreen);
        expect(host.textContent).toContain(pseudoLocalise('📸 Choose your look'));
        await click(button('Change Photo or Avatar'), 'Change Photo or Avatar');
        expect(host.textContent).toContain(pseudoLocalise('Profile Photo'));
        expect(host.textContent).toContain(pseudoLocalise('Or choose an avatar — swipe for more:'));
        expect(byLabel('Show more avatars')).not.toBeNull();
        // Each avatar is read by its own name, in the member's language.
        expect(host.querySelector(`[aria-label="${pseudoLocalise('Select {name} avatar').replace('{name}', pseudoLocalise('Sunflower'))}"]`)).not.toBeNull();
        expect(bypassing(), 'sheet').toEqual([]);
        await click(byLabel('Take photo with camera'), 'Camera');
        expect(alerts.said).toEqual([pseudoLocalise('Permission required'), pseudoLocalise('Camera access is needed.')]);
        await click(byLabel('Choose photo from gallery'), 'Gallery');
        expect(alerts.said).toContain(pseudoLocalise('Could not pick image.'));
        await click(host.querySelector(`[aria-label="${pseudoLocalise('Select {name} avatar').replace('{name}', pseudoLocalise('Green Bean'))}"]`), 'an avatar');
        expect(host.textContent).toContain(pseudoLocalise('Use Selected Avatar'));
        expect(bypassing(), 'picked').toEqual([]);
    });

    it('the area step on a community that syncs by area, its failure line, and the guide with no Beans', async () => {
        prof.value = { profile: 'global', features: GLOBAL_FEATURES, checkedAt: new Date().toISOString() };
        nav.params = { name: 'Sally' };
        answers = { '/api/community/me/area': { status: 500, body: {} } };
        await renderIn('xx', ProfileSetupScreen);
        await click(button('Next →'), 'Next');
        await click(host.querySelector('[data-testid="area-type-town"]'), 'Type a town');
        await click(host.querySelector('[data-testid="pick-byron"]'), 'Byron Bay');
        // utils/member-area.ts keeps its English (it signs the request); the step draws it in the member's language.
        expect(host.textContent).toContain(pseudoLocalise('The community said no ({status}). Try again later.').replace('{status}', '500'));
        expect(bypassing(), 'area').toEqual([]);
        await click(host.querySelector('[data-testid="area-skip"]'), 'Skip');
        expect(host.textContent).toContain(pseudoLocalise('🫘 How BeanPool works'));
        expect(host.textContent).toContain(pseudoLocalise('A quick look at this community.'));
        expect(host.textContent).toContain(pseudoLocalise('🌍 A place to meet'));
        expect(host.textContent).not.toContain(pseudoLocalise('🪙 The Mutual Credit Ledger'));
        expect(byLabel('Done')).not.toBeNull();
        expect(bypassing(), 'guide, no Beans').toEqual([]);
    });

    it('the guide with Beans: each card, the bold words inside their sentences; a name taken at the last moment', async () => {
        nav.params = { name: 'Sally' };
        answers = { '/api/profile/update': { status: 409, body: {} } };
        await renderIn('xx', ProfileSetupScreen);
        await click(button('Next →'), 'Next');
        expect(host.textContent).toContain(pseudoLocalise('🪙 The Mutual Credit Ledger'));
        expect(host.textContent).toContain(pseudoLocalise('A quick look at this community economy.'));
        // The bold words sit inside the sentence they belong to, wherever its language puts them.
        const map = pseudoLocalise('📍 Explore the {map} to find offers (green) and needs (orange) near you.').split('{map}');
        expect(host.textContent).toContain(`${map[0]}${pseudoLocalise('Map')}${map[1]}`);
        const zero = pseudoLocalise('🟢 {zero} This means you have given as much value to your community as you have received from it.').split('{zero}');
        expect(host.textContent).toContain(`${zero[0]}${pseudoLocalise('The best place to be is zero (0 Beans).')}${zero[1]}`);
        expect(host.textContent).toContain(pseudoLocalise('💳 Use the {ledger} tab to send credits to neighbors instantly.').split('{ledger}')[0]);
        expect(bracketed()).toBeGreaterThan(20);
        expect(bypassing(), 'guide').toEqual([]);
        await click(button('Done ✓'), 'Done');
        expect(host.textContent).toContain(pseudoLocalise('That name was just taken — please pick another.'));
        expect(bypassing(), 'taken at the end').toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        nav.params = { name: 'Sally' };
        await renderIn('en', ProfileSetupScreen);
        expect(bracketed()).toBe(0);
        for (const english of ['Step 2 of 3', '📸 Choose your look', 'Add a photo, or pick a fun avatar — whatever feels like you.', 'Change Photo or Avatar', 'Next →', '← Back']) {
            expect(host.textContent, english).toContain(english);
        }
        await click(button('Next →', 'en'), 'Next');
        for (const english of ['🫘 How BeanPool works', '⚡ Energy Exchange Marketplace',
            '🟢 The best place to be is zero (0 Beans). This means you have given as much value to your community as you have received from it.',
            '📍 Explore the Map to find offers (green) and needs (orange) near you.', '💬 Tap Message on any post to chat securely (E2E encrypted) with neighbors.',
            '➕ Click Post to list what you need or what you can offer to the community.', '💳 Use the Ledger tab to send credits to neighbors instantly.', 'Done ✓']) {
            expect(host.textContent, english).toContain(english);
        }
    });
});

describe('Your area and Suggest a change in the pseudo-locale', () => {
    it('Your area: the current area, Clear, and a Clear the community refused', async () => {
        answers = {
            '/api/community/me/area': { status: 503, body: {} },
            '/api/community/me': { status: 200, body: { area: { lat: -28.6, lng: 153.6, updatedAt: '2026-10-11T00:00:00.000Z' } } },
        };
        await renderIn('xx', YourAreaScreen);
        expect(host.querySelector('[data-testid="your-area-current"]')?.textContent).toMatch(/^\[.*\]$/s);
        await click(host.querySelector('[data-testid="your-area-clear"]'), 'Clear');
        expect(host.textContent).toContain(pseudoLocalise('The community said no ({status}). Try again later.').replace('{status}', '503'));
        expect(bypassing()).toEqual([]);
    });

    it('Suggest a change: the form, each of core\'s refusals, the project out of reach, and the thanks', async () => {
        await renderIn('xx', SuggestChangeScreen);
        expect(host.textContent).toContain(pseudoLocalise('SUGGEST A CHANGE'));
        expect(host.textContent).toContain(pseudoLocalise("This goes to the BeanPool project team, not to your community. Don't include personal details."));
        expect(Array.from(host.querySelectorAll('[role="radio"]')).map((r) => r.textContent)).toEqual(['Idea', 'Problem', 'Other'].map((w) => pseudoLocalise(w)));
        expect(host.textContent).toContain('0 / 2000');
        expect(bypassing(), 'form').toEqual([]);
        await click(button('SEND'), 'SEND');
        expect(host.textContent).toContain(pseudoLocalise('Please write at least {n} characters.').replace('{n}', '10'));
        expect(bypassing(), 'too short').toEqual([]);
        await type(host.querySelector('textarea, input'), 'A longer suggestion about the market.');
        await type(host.querySelectorAll('input')[1] ?? null, 'Mullum Commons');
        answers = { [FEEDBACK_ENDPOINT]: 'offline' };
        await click(button('SEND'), 'SEND');
        expect(host.textContent).toContain(pseudoLocalise("Couldn't reach the BeanPool project just now. Your text is still here — please try again later."));
        answers = { [FEEDBACK_ENDPOINT]: { status: 429, body: {} } };
        await click(button('SEND'), 'SEND');
        expect(host.textContent).toContain(pseudoLocalise('Too many suggestions from your connection recently. Please try again later — your text is still here.'));
        expect(bypassing(), 'refused').toEqual([]);
        // The project's own sentence is shown as it sent it.
        answers = { [FEEDBACK_ENDPOINT]: { status: 503, body: { error: 'The node is busy.' } } };
        await click(button('SEND'), 'SEND');
        expect(host.textContent).toContain('The node is busy.');
        answers = { [FEEDBACK_ENDPOINT]: { status: 200, body: { ok: true } } };
        await click(button('SEND'), 'SEND');
        expect(host.textContent).toContain(pseudoLocalise('Thank you — your suggestion has reached the BeanPool project team.'));
        expect(host.textContent).toContain(pseudoLocalise('DONE'));
        expect(bypassing(), 'sent').toEqual([]);
    });

    it('the area step\'s failure lines are member-area.ts\'s, line for line', async () => {
        const failure = async (point: { lat: number; lng: number }) => {
            const result = await writeMemberArea(NODE, IDENTITY, point);
            expect(result.ok).toBe(false);
            return (result as { error: string }).error;
        };
        const sentences = [await failure({ lat: Number.NaN, lng: 1 })];
        answers = {};
        sentences.push(await failure({ lat: 1, lng: 1 }));
        answers = { '/api/community/me/area': { status: 403, body: {} } };
        sentences.push(await failure({ lat: 1, lng: 1 }));
        expect(sentences).toEqual([
            "That place couldn't be read. Try again or type a town.",
            "Couldn't reach the community. Check your connection and try again.",
            'The community said no (403). Try again later.',
        ]);
        for (const s of sentences) expect(areaSaveFailureWords(s), s).toBe(s);
        setLanguage('xx');
        for (const s of sentences) expect(areaSaveFailureWords(s), s).toMatch(/^\[.*\]$/s);
        // The community's own sentence stays as it came.
        expect(areaSaveFailureWords('The node is busy.')).toBe('The node is busy.');
    });
});

// ── 320 dp with text at 1.3×: longer languages never push words past an edge (checked with the pseudo-locale) ─────────
const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[️​‌‍]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);
/** The widest piece a line can't break inside: a word (the pseudo-locale's ~ padding models a longer word, not a word of its own). */
const widestWord = (text: string) => text.split(/[\s​~]+/).reduce((a, b) => (widthOf(b, 1) > widthOf(a, 1) ? b : a), '');
/** The size a text is drawn at: its own, or the one it inherits from the text it sits in. */
const fontOf = (el: Element): number => { for (let e: Element | null = el; e; e = e.parentElement) { const f = e.getAttribute('data-font'); if (f) return Number(f); } return 14; };
/** Leaves drawn in the pseudo-locale. */
const drawnWords = () => Array.from(host.querySelectorAll('span')).filter((s) => s.children.length === 0 && /^\[/.test(s.textContent ?? ''));

/** No word wider than `column` at the size it is drawn at (its smallest, where it shrinks). */
function tooWide(column: number, within: ParentNode = host): string[] {
    const out: string[] = [];
    for (const span of Array.from(within.querySelectorAll('span')).filter((s) => /\p{L}/u.test(s.textContent ?? ''))) {
        const px = fontOf(span) * SCALE * Number(span.getAttribute('data-min-scale') ?? 1);
        const word = widestWord(span.textContent ?? '');
        if (widthOf(word, px) > column) out.push(`${word} (${Math.round(widthOf(word, px))} > ${column})`);
    }
    return out;
}
/**
 * A text drawn beside something else in a row must be able to give way (flex, or flexShrink), so a longer language
 * wraps inside the row rather than pushing past the screen's edge or over a button: React Native's default flexShrink
 * is 0. A short tag beside a column that gives way is fine.
 */
function stuckInRows(): string[] {
    const out: string[] = [];
    for (const span of drawnWords()) {
        const row = span.parentElement;
        if (!row || row.getAttribute('data-row') !== 'true' || row.children.length < 2) continue;
        if (span.getAttribute('data-flex') || span.getAttribute('data-flex-shrink')) continue;
        const sibling = Array.from(row.children).some((k) => k !== span && (k.getAttribute('data-flex') || k.getAttribute('data-flex-shrink')));
        if (sibling && widthOf(span.textContent ?? '', fontOf(span) * SCALE) <= 320 * 0.4) continue;
        out.push(span.textContent ?? '');
    }
    return out;
}

describe('the screens at 320 dp with 1.3× text, in the pseudo-locale', () => {
    it('profile setup: every step\'s words fit the card (320 - 2 × 20 page - 2 × 20 card), and nothing is stuck in a row', async () => {
        nav.params = { name: 'Sally' };
        await renderIn('xx', ProfileSetupScreen);
        await afterTheNameCheck();
        expect(tooWide(240)).toEqual([]);
        expect(stuckInRows()).toEqual([]);
        await click(button('Next →'), 'Next');
        expect(drawnWords().length).toBeGreaterThan(20);
        // The guide's cards: 16 padding and a border inside the card, and the emoji beside a bullet's words.
        expect(tooWide(240 - 2 * 17 - (18 * SCALE * 1.25 + 10))).toEqual([]);
        expect(stuckInRows()).toEqual([]);
    });

    it('the Profile Photo sheet: Camera and Gallery stay whole in their half of the row, on two lines at most, shrinking', async () => {
        nav.params = { name: 'Sally' };
        await renderIn('xx', ProfileSetupScreen);
        await click(button('Change Photo or Avatar'), 'Change Photo or Avatar');
        const sheet = host.querySelector('[data-modal]')!;
        // 320 - 2 × 20 (the content's padding) - 16 (the gap), halved, less 2 × 20 padding and 2 × 2 border.
        const half = (320 - 40 - 16) / 2 - 40 - 4;
        for (const english of ['Camera', 'Gallery']) {
            const label = Array.from(sheet.querySelectorAll('span')).find((s) => s.textContent === pseudoLocalise(english))!;
            expect(label, english).toBeTruthy();
            expect(label.getAttribute('data-lines'), english).toBe('2');
            const px = 16 * SCALE * Number(label.getAttribute('data-min-scale'));
            expect(widthOf(widestWord(label.textContent!), px), english).toBeLessThanOrEqual(half);
            expect(widthOf(label.textContent!, px), english).toBeLessThanOrEqual(2 * half * 0.9);
        }
        expect(tooWide(320 - 40, sheet)).toEqual([]);
        expect(stuckInRows()).toEqual([]);
    });

    it('the Profile Photo sheet in French: "Appareil photo" keeps to its half too', async () => {
        nav.params = { name: 'Sally' };
        const fr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words/fr.json'), 'utf8')) as Record<string, string>;
        await renderIn('fr', ProfileSetupScreen);
        await click(button(fr['Change Photo or Avatar'] ?? 'Change Photo or Avatar', 'fr'), 'Change Photo or Avatar');
        const label = Array.from(host.querySelectorAll('[data-modal] span')).find((s) => s.textContent === fr.Camera)!;
        expect(label, fr.Camera).toBeTruthy();
        const half = (320 - 40 - 16) / 2 - 40 - 4;
        const px = 16 * SCALE * Number(label.getAttribute('data-min-scale'));
        expect(widthOf(widestWord(label.textContent!), px)).toBeLessThanOrEqual(half);
    });

    it('Suggest a change: the header takes two lines at most between Close and the spacer, in capitals of its own', async () => {
        await renderIn('xx', SuggestChangeScreen);
        const header = host.querySelector('[role="heading"]')!;
        expect(header.textContent).toBe(pseudoLocalise('SUGGEST A CHANGE'));
        expect(header.getAttribute('data-transform')).toBeNull();
        expect(header.getAttribute('data-lines')).toBe('2');
        // 320 - 2 × 16 (the header's padding) - 48 (Close) - 48 (the spacer).
        const line = 320 - 32 - 96;
        const px = 16 * SCALE * Number(header.getAttribute('data-min-scale'));
        expect(widthOf(widestWord(header.textContent!), px)).toBeLessThanOrEqual(line);
        expect(widthOf(header.textContent!, px)).toBeLessThanOrEqual(2 * line * 0.9);
        // The page's words: 320 - 2 × 20; the kind chips wrap as a row.
        expect(tooWide(320 - 40)).toEqual([]);
        expect(stuckInRows()).toEqual([]);
    });
});

describe('profile setup follows a language picked while it is open', () => {
    const fr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words/fr.json'), 'utf8')) as Record<string, unknown>;

    it('a pick redraws the step in the new language, with nothing by hand; the member\'s name stays as written', async () => {
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(ProfileSetupScreen)),
                createElement(LanguagePickerSheet, { visible: true, onClose() {} })) as any);
        });
        await settle();
        expect(host.textContent).toContain('Next →');
        expect(host.textContent).toContain('Cancel');
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        await settle();
        for (const english of ['Next →', 'Cancel']) {
            expect(typeof fr[english], english).toBe('string');
            expect(host.textContent).toContain(fr[english] as string);
        }
        expect(host.textContent).not.toContain('Next →');
        expect((host.querySelector('input') as HTMLInputElement).value).toBe('Sally');
    });
});
