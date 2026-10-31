// @vitest-environment jsdom
/**
 * The sign-in restore's release screen with a copy that listed communities (vault rethink VR5; app/welcome.tsx, the
 * `ssoReleased` branch): the copy's communities are drawn by SavedNodePicker, beside this phone's own, and "Which
 * community?" starts at the copy's first. Rendered for real (#2660 deciding review, test note): at 320 dp with text at
 * 1.3×, a long name from the copy wraps on a full touch target beside its chevron, never cut, in light and dark.
 *
 * And the lines under the field (#2660 finding 3) name what the field really holds: the copy's community by the copy's
 * name for it, the global community, or neither, never "the global community is filled in" for a field holding another.
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
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => { if (!disabled) onPress(); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (accessibilityState?.selected) attrs['aria-selected'] = 'true';
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        attrs['data-style'] = JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter((x) => x && typeof x === 'object')));
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
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { onboardingColors } = await import('../onboarding-colors');
    return { useOnboardingColors: () => onboardingColors(theme.dark ? 'dark' : 'light') };
});

import { SavedNodePicker } from '../../components/SavedNodePicker';
import { LanguageProvider } from '../../components/LanguageProvider';
import { setLanguage } from '@beanpool/core';
import { onboardingColors } from '../onboarding-colors';
import { GLOBAL_NODE_URL } from '../global-node-url';
import { fieldTextFor, releaseFieldHints, releaseFieldHolds, withCopyCommunities } from '../restore-community-choices';

const LONG = 'Gemeinschaftsgarten Nördliche Flussauen und Umgebung';
const FROM_COPY = [
    { name: LONG, url: 'https://garten.example.org' },
    { name: 'Lismore Commons', url: 'https://lismore.example.org' },
];
const SAVED = [{ url: 'https://mullum.beanpool.org', alias: 'Mullumbimby' }];

let host: HTMLDivElement;
let root: Root;
const picked: string[] = [];
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    picked.length = 0;
    theme.dark = false;
    setLanguage('en');
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

/** The picker as the release screen draws it (app/welcome.tsx), in German: the long words. */
async function draw(selected: string | null = null): Promise<void> {
    const picker = createElement(SavedNodePicker, {
        nodes: withCopyCommunities(SAVED, FROM_COPY),
        onPick: (url: string) => { picked.push(url); },
        selectedUrl: selected,
        label: 'Your communities, on this phone and in your copy',
        actionLabel: 'Open in',
        hint: "Or type a community's name or address below.",
    });
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['de-DE'], initial: 'de' }, picker) as any); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const rows = () => Array.from(host.querySelectorAll('button')) as HTMLElement[];
const style = (el: Element) => JSON.parse(el.getAttribute('data-style') ?? '{}');

describe("the copy's communities on the release screen (SavedNodePicker)", () => {
    it("lists the phone's own, then the copy's, each once, by the copy's name; a tap picks its address", async () => {
        await draw();
        expect(rows().map((r) => r.querySelector('span')!.textContent)).toEqual(['Mullumbimby', LONG, 'Lismore Commons']);
        await act(async () => { rows()[1].click(); });
        expect(picked).toEqual(['https://garten.example.org']);
    });

    for (const dark of [false, true]) {
        it(`at 320 dp with text at 1.3× (${dark ? 'dark' : 'light'}): a long name wraps beside its chevron on a full touch target, never cut`, async () => {
            theme.dark = dark;
            await draw('https://garten.example.org');
            const row = rows()[1];
            expect(row.getAttribute('aria-selected')).toBe('true');
            const s = style(row);
            expect(s.flexDirection).toBe('row');
            expect(s.minHeight).toBeGreaterThanOrEqual(48);
            // The name's column takes what the chevron leaves and wraps there: no line cap on the name or its host.
            const column = row.querySelector('div')!;
            expect(style(column).flex).toBe(1);
            for (const text of Array.from(row.querySelectorAll('span'))) expect(text.getAttribute('data-lines')).toBeNull();
            // Drawn from the theme's tokens, light or dark: the name in the heading colour on the app's surface.
            const c = onboardingColors(dark ? 'dark' : 'light').colors;
            expect(style(row.querySelector('span')!).color).toBe(c.text.heading);
            expect(s.backgroundColor).toBe(c.surface.app);
            // The label above wraps too.
            expect(host.querySelector('div > span')!.getAttribute('data-lines')).toBeNull();
        });
    }

    it('app/welcome.tsx draws this picker with the copy\'s list on the release screen', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
        expect(src).toContain('nodes={withCopyCommunities(savedNodes, ssoReleased.communities)}');
    });
});

describe('the lines under "Which community?" name what the field holds (#2660 finding 3)', () => {
    const first = FROM_COPY[1];
    const GLOBAL_FIELD = GLOBAL_NODE_URL.replace(/^https:\/\//, '');

    it("filled from the copy: the copy's community by its name, never the global one", () => {
        expect(releaseFieldHolds(fieldTextFor(first.url), first)).toEqual({ kind: 'copy', name: 'Lismore Commons' });
        const { hint, a11y } = releaseFieldHints(fieldTextFor(first.url), first);
        expect(hint).toBe('Lismore Commons, from your copy, is filled in. To open your account in another community, pick it above or type its name or address. Your name and picture come back from it.');
        expect(a11y).toBe("Lismore Commons, from your copy, is filled in. Enter your community's name, like mullum, or its full address");
        for (const line of [hint, a11y]) expect(line).not.toMatch(/global/i);
        // A copy's community with no name is named by its host.
        expect(releaseFieldHolds('lismore.example.org', { name: '', url: first.url })).toEqual({ kind: 'copy', name: 'lismore.example.org' });
    });

    it('the global community, as the field starts without a list: said as before', () => {
        expect(releaseFieldHolds(GLOBAL_FIELD, undefined)).toEqual({ kind: 'global' });
        expect(releaseFieldHints(GLOBAL_FIELD, undefined).hint).toBe('The global community is filled in. If you belong to a local community, type its name or address. Your name and picture come back from it.');
        expect(releaseFieldHints(GLOBAL_FIELD, first).a11y).toBe("The global community is filled in. Enter your community's name, like mullum, or its full address");
    });

    it('anything else (typed, picked, or emptied): no claim of what is filled in', () => {
        for (const field of ['', 'mullum', 'https://castlemaine.beanpool.org']) {
            expect(releaseFieldHolds(field, first)).toEqual({ kind: 'other' });
            const { hint, a11y } = releaseFieldHints(field, first);
            for (const line of [hint, a11y]) expect(line).not.toMatch(/filled in/);
        }
    });

    it('app/welcome.tsx: the field and the line under it both take their words from what it holds', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
        expect(src).toContain('accessibilityHint={releaseFieldHints(ssoCommunity, ssoReleased.communities?.[0]).a11y}');
        expect(src).toContain('{releaseFieldHints(ssoCommunity, ssoReleased.communities?.[0]).hint}');
        expect(src).not.toContain("t('The global community is filled in. If you belong");
    });
});
