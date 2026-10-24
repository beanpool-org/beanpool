// @vitest-environment jsdom
/**
 * The BeanPool sheet in the member's language (words slice S3, sweep B4; app/beanpool.tsx, which Settings' "Help & how it
 * works" opens, as the header's bean does): rendered for real inside the real LanguageProvider, with the communities the
 * phone has saved and the global community's door as the hooks report them (beanpool-global-row-render.test.ts drives
 * those hooks for real), and the members' guide built into the app.
 *
 * In the pseudo-locale (`xx`) any text, label, hint or placeholder with letters outside a bracket bypassed t(). Shown as
 * written: the guide's own pages (their titles, summaries and search snippets: useGuide, stood in for here, puts them in
 * the member's language, which guide-words-render.test.ts checks), the communities' names and addresses, the mark
 * (BeanPool) and the website's name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The screen doesn't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

const shared = vi.hoisted(() => ({ messages: [] as string[] }));
// use-global-guest-visit reads useNodeStatus().recheck (only during a visit, which these screens never start); the real
// context pulls expo-crypto in at import.
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'unknown' }) }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, value, onChangeText, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        const s = flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style);
        if (s.flexDirection === 'row') attrs['data-row'] = 'true';
        if (s.flex !== undefined) attrs['data-flex'] = String(s.flex);
        if (typeof s.flexShrink === 'number' && s.flexShrink > 0) attrs['data-flex-shrink'] = String(s.flexShrink);
        if (typeof s.maxWidth === 'number') attrs['data-max-width'] = String(s.maxWidth);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => flat(s) },
        Share: { share: async ({ message }: { message: string }) => { shared.messages.push(message); return {}; } },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Linking: { openURL: async () => {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    const router = { push() {}, navigate() {}, back() {}, replace() {}, canGoBack: () => true };
    return { router, useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]), ErrorBoundary: () => null };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
vi.mock('../use-guide', async () => {
    const { getBundledGuide } = await import('../guide');
    return { useGuide: () => ({ guide: getBundledGuide(), source: 'bundled' }) };
});
// "Suggest a change" shows only while FEEDBACK_LIVE; here it is drawn, so its words are checked.
vi.mock('../guide', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../guide')>()),
    beanPoolSheetEntries: () => ['suggest', 'whats-new', 'website'],
}));
vi.mock('../beanpool-links', () => ({ openBeanPoolWebsite: async () => {} }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('../../app/IdentityContext', () => ({
    useIdentity: () => ({ identity: { publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64), callsign: 'Damo' }, setIdentity() {} }),
}));
vi.mock('../global-join-existing', () => ({
    isGlobalCommunity: (url: string | null | undefined) => !!url && url.trim().replace(/\/+$/, '').toLowerCase() === 'https://global.beanpool.org',
}));
vi.mock('../use-global-door-open', () => ({ useGlobalDoor: () => ({ state: 'open', wordsDoor: true, retry() {} }) }));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'join' }));
const list = vi.hoisted(() => ({
    rows: [] as { url: string; name: string; status: 'checking' | 'online' | 'guest' | 'offline' }[],
    active: null as string | null | undefined,
    lastSync: null as number | null,
}));
vi.mock('../use-communities', () => ({
    useCommunities: () => ({
        active: list.active,
        current: list.rows.find((r) => r.url === list.active) ?? null,
        rows: list.rows,
        lastSync: list.lastSync,
        switching: false,
        switchTo: async () => {},
        remove: () => {},
    }),
}));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { getBundledGuide, searchGuide } from '../guide';
import BeanPoolSheet from '../../app/beanpool';
import { NOTICE_COUNTS_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const RIVERSIDE = 'https://riverside.example';
const HILLS = 'https://hills.example';

/** Shown as written: the guide's pages, the communities, the mark and the website's name. */
function writtenByOthers(): string[] {
    const guide = getBundledGuide() as unknown as {
        pages?: Array<{ title?: string; summary?: string }>; sections?: Array<{ title?: string; summary?: string }>;
        collections?: unknown;
    };
    const out = new Set<string>(['Riverside', 'Hills', 'riverside.example', 'hills.example', 'beanpool.org', 'BeanPool']);
    const walk = (x: unknown) => {
        if (!x || typeof x !== 'object') return;
        if (Array.isArray(x)) { x.forEach(walk); return; }
        for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
            if ((k === 'title' || k === 'summary') && typeof v === 'string') out.add(v);
            else walk(v);
        }
    };
    walk(guide);
    for (const q of ['beans', 'zzzqqqxx']) for (const r of searchGuide(getBundledGuide(), q)) { out.add(r.page.title); out.add(r.snippet); }
    return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}
const OTHERS = writtenByOthers();

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    shared.messages.length = 0;
    list.rows = [{ url: RIVERSIDE, name: 'Riverside', status: 'online' }, { url: HILLS, name: 'Hills', status: 'offline' }];
    list.active = RIVERSIDE;
    list.lastSync = Date.now() - 5 * 60_000;
    globalThis.fetch = vi.fn(async () => { throw new TypeError('offline'); }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(BeanPoolSheet)) as any); });
    await settle();
}
const type = async (el: Element | null | undefined, text: string) => {
    expect(el).toBeTruthy();
    const input = el as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};
const xx = (english: string, values: Record<string, string> = {}) =>
    Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), pseudoLocalise(english));

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
    for (const [attr, kind] of [['aria-label', 'label'], ['data-hint', 'hint'], ['placeholder', 'placeholder']] as const) {
        for (const e of Array.from(host.querySelectorAll(`[${attr}]`))) {
            const v = e.getAttribute(attr);
            if (outsideBrackets(v)) out.add(`${kind}: ${JSON.stringify(v)}`);
        }
    }
    return [...out];
}

describe('the BeanPool sheet in the pseudo-locale: every word on it came through t() (words S3e)', () => {
    it('a member online: the status with its sync time, the saved rows read by TalkBack, the global row, the guides, the project', async () => {
        await renderIn('xx');
        const synced = xx('synced {n}m ago', { n: '5' });
        expect(host.textContent).toContain(xx('{status} · {synced}', { status: pseudoLocalise('Connected. You are a member here.'), synced }));
        expect(host.querySelector(`[aria-label="${xx('{status}, {synced}', { status: pseudoLocalise('Connected. You are a member here.'), synced })}"]`)).not.toBeNull();
        expect(host.querySelector(`[aria-label="${xx('{name}, {state}, in use', { name: 'Riverside', state: pseudoLocalise('Connected. You are a member here.') })}"]`)).not.toBeNull();
        expect(host.querySelector(`[aria-label="${xx('{name}, {state}', { name: 'Hills', state: pseudoLocalise("Can't reach it right now") })}"]`)).not.toBeNull();
        expect(host.textContent).toContain(pseudoLocalise('YOUR COMMUNITIES'));
        expect(host.textContent).toContain(pseudoLocalise('THE BEANPOOL PROJECT'));
        expect(host.textContent).toContain(pseudoLocalise('Suggest a change'));
        expect(host.textContent).toContain(pseudoLocalise('Works without a connection.'));
        expect(bypassing()).toEqual([]);
        // The website's share says its sentence in the member's language, the address as it is.
        const share = host.querySelector(`[aria-label="${pseudoLocalise('Share beanpool.org')}"]`) as HTMLElement;
        await act(async () => { share.click(); });
        expect(shared.messages).toEqual([xx('BeanPool: trade with your neighbours using beans. {url}', { url: 'https://beanpool.org' })]);
    });

    it('a guest, a phone with no community, a connection being checked: each line and its next step', async () => {
        // A guest where the phone is now, and a guest in another saved community (its row's tag).
        list.rows = [{ url: RIVERSIDE, name: 'Riverside', status: 'guest' }, { url: HILLS, name: 'Hills', status: 'guest' }];
        await renderIn('xx');
        expect(host.textContent).toContain(pseudoLocalise('Visiting as a guest'));
        expect(host.textContent).toContain(pseudoLocalise('Join this community'));
        expect(host.textContent).toContain(pseudoLocalise('Guest'));
        expect(bypassing(), 'guest').toEqual([]);

        act(() => root.unmount());
        root = createRoot(host);
        list.rows = [];
        list.active = null;
        await renderIn('xx');
        expect(host.textContent).toContain(pseudoLocalise('No community yet'));
        expect(host.textContent).toContain(pseudoLocalise('Not connected to a community yet'));
        expect(host.textContent).toContain(pseudoLocalise('Connect to a community'));
        expect(bypassing(), 'none').toEqual([]);

        act(() => root.unmount());
        root = createRoot(host);
        list.rows = [{ url: RIVERSIDE, name: 'Riverside', status: 'checking' }];
        list.active = RIVERSIDE;
        await renderIn('xx');
        expect(host.textContent).toContain(pseudoLocalise('Checking the connection…'));
        expect(bypassing(), 'checking').toEqual([]);
    });

    it('the guide search: nothing found, and a count of pages', async () => {
        await renderIn('xx');
        await type(host.querySelector('input'), 'zzzqqqxx');
        expect(host.textContent).toContain(pseudoLocalise('NOTHING FOUND'));
        expect(host.textContent).toContain(pseudoLocalise('No page has all of those words. Try one word, like "gift" or "vote".'));
        expect(bypassing(), 'nothing').toEqual([]);
        await type(host.querySelector('input'), 'beans');
        const n = searchGuide(getBundledGuide(), 'beans').length;
        expect(n).toBeGreaterThan(1);
        expect(host.textContent).toContain(xx('{n} PAGES', { n: String(n) }));
        expect(bypassing(), 'found').toEqual([]);
    });

    // Marty, 24 Oct: "the node list should have little numbers if there are notifications on a node" (utils/notice-counts.ts).
    it('each other community\'s row shows how many notices it sent since it was last open, and TalkBack reads it; the one in use and 0 show nothing', async () => {
        const seen = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${i}`.padStart(32, '0'), 1_800_000_000]));
        store.map.set('beanpool_anchor_url', RIVERSIDE);
        store.map.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: RIVERSIDE }, { url: HILLS }]));
        store.map.set(NOTICE_COUNTS_STORE_KEY, JSON.stringify({ [HILLS]: { n: 3, seen: seen(3) }, [RIVERSIDE]: { n: 2, seen: seen(2) } }));
        await renderIn('xx');
        const hills = host.querySelector(`[aria-label="${xx('{row}, {notices}', {
            row: xx('{name}, {state}', { name: 'Hills', state: pseudoLocalise("Can't reach it right now") }),
            notices: xx('{n} new notifications', { n: '3' }),
        })}"]`);
        expect(hills).not.toBeNull();
        expect(Array.from(hills!.querySelectorAll('span')).map((s) => s.textContent)).toContain('3');
        // The community in use: its row as before, no number (the phone is on it).
        const riverside = host.querySelector(`[aria-label="${xx('{name}, {state}, in use', { name: 'Riverside', state: pseudoLocalise('Connected. You are a member here.') })}"]`);
        expect(riverside).not.toBeNull();
        expect(Array.from(riverside!.querySelectorAll('span')).map((s) => s.textContent)).not.toContain('2');
        expect(bypassing()).toEqual([]);

        // In English, one and many; more than 99 drawn as 99+.
        act(() => root.unmount());
        root = createRoot(host);
        store.map.set(NOTICE_COUNTS_STORE_KEY, JSON.stringify({ [HILLS]: { n: 1, seen: seen(1) } }));
        await renderIn('en');
        expect(host.querySelector('[aria-label="Hills, Can\'t reach it right now, 1 new notification"]')).not.toBeNull();
        act(() => root.unmount());
        root = createRoot(host);
        store.map.set(NOTICE_COUNTS_STORE_KEY, JSON.stringify({ [HILLS]: { n: 120, seen: seen(1) } }));
        await renderIn('en');
        const many = host.querySelector('[aria-label="Hills, Can\'t reach it right now, 120 new notifications"]');
        expect(Array.from(many!.querySelectorAll('span')).map((s) => s.textContent)).toContain('99+');

        // None counted: the row is as it was.
        act(() => root.unmount());
        root = createRoot(host);
        store.map.delete(NOTICE_COUNTS_STORE_KEY);
        await renderIn('en');
        const plain = host.querySelector('[aria-label="Hills, Can\'t reach it right now"]');
        expect(plain).not.toBeNull();
        expect(Array.from(plain!.querySelectorAll('span')).map((s) => s.textContent)).toEqual(['Hills', 'hills.example']);
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        await renderIn('en');
        for (const english of ['Connected. You are a member here. · synced 5m ago', 'YOUR COMMUNITIES', 'Add a community', 'GUIDES', 'HOW TO USE THE APP',
            'THE BEANPOOL PROJECT', 'Suggest a change', 'The public website, to share with friends', 'Share', 'Works without a connection.']) {
            expect(host.textContent, english).toContain(english);
        }
        expect(host.textContent).toMatch(/BeanPool v\d+\.\d+\.\d+ \(\d+\)\nGuide version \d+ · built into the app\nWorks without a connection\./);
        expect(host.querySelector('[aria-label="Riverside, Connected. You are a member here., in use"]')).not.toBeNull();
        expect(host.querySelector('[aria-label="Connected. You are a member here., synced 5m ago"]')).not.toBeNull();
        expect(Array.from(host.querySelectorAll('span')).some((s) => /^\[/.test(s.textContent ?? ''))).toBe(false);
    });
});

// ── 320 dp with text at 1.3× (checked with the pseudo-locale) ─────────────────────────────────────────────────────────
const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);
const widestWord = (text: string) => text.split(/[\s\u200B~]+/).reduce((a, b) => (widthOf(b, 1) > widthOf(a, 1) ? b : a), '');
const fontOf = (el: Element): number => { for (let e: Element | null = el; e; e = e.parentElement) { const f = e.getAttribute('data-font'); if (f) return Number(f); } return 14; };

describe('the BeanPool sheet at 320 dp with 1.3× text, in the pseudo-locale', () => {
    // A row's text column (beanpool-global-row-render.test.ts measures it from the styles): 188.
    const COLUMN = 188;

    it('no word wider than its line, and nothing beside an icon or a button that can\'t give way', async () => {
        list.rows = [{ url: RIVERSIDE, name: 'Riverside', status: 'guest' }];
        await renderIn('xx');
        const out: string[] = [];
        for (const span of Array.from(host.querySelectorAll('span')).filter((s) => /\p{L}/u.test(s.textContent ?? ''))) {
            const px = fontOf(span) * SCALE * Number(span.getAttribute('data-min-scale') ?? 1);
            const word = widestWord(span.textContent ?? '');
            if (widthOf(word, px) > COLUMN) out.push(`${word} (${Math.round(widthOf(word, px))})`);
            const row = span.parentElement;
            if (/^\[/.test(span.textContent ?? '') && row?.getAttribute('data-row') === 'true' && row.children.length > 1
                && !span.getAttribute('data-flex') && !span.getAttribute('data-flex-shrink')
                && !Array.from(row.children).some((k) => k !== span && (k.getAttribute('data-flex') || k.getAttribute('data-flex-shrink')))) {
                out.push(`stuck in a row: ${span.textContent}`);
            }
        }
        expect(out).toEqual([]);
        // The guest's Join button: its words give way beside the icon.
        const join = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === pseudoLocalise('Join this community'))!;
        expect(join.getAttribute('data-flex-shrink')).toBe('1');
    });

    it('Share keeps to 104 dp, shrinking to fit, so the website\'s line keeps its room', async () => {
        await renderIn('xx');
        const share = host.querySelector(`[aria-label="${pseudoLocalise('Share beanpool.org')}"]`)!;
        expect(share.getAttribute('data-max-width')).toBe('104');
        const words = share.querySelector('span')!;
        expect(words.getAttribute('data-lines')).toBe('1');
        expect(words.getAttribute('data-shrinks')).toBe('true');
        const px = 14 * SCALE * Number(words.getAttribute('data-min-scale'));
        // 104 less 2 × 12 padding.
        expect(widthOf(words.textContent!, px)).toBeLessThanOrEqual(104 - 24);
    });
});

