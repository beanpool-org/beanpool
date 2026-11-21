// @vitest-environment jsdom
/**
 * The bell sheet's way-back line drawn (components/WayBackBellLine.tsx, slice B1 of DESIGN-notify-and-backup-asks-fable-amend2.md
 * §12.3; the first design §5.2 "After ×"): "No way back in yet. Keep one ›" once Home's card has been put away, until a way
 * back is kept, never while the card is still up, nowhere with no reminder. In every colour set the app draws (light and
 * dark among them), on the sheet's card: the words and the link readable (4.5:1), the row wrapping at 320 dp with 1.3x
 * text, a 44 dp target, one button that reads its own words, and a tap that opens Account Protection and closes the sheet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(4).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (testID) attrs['data-testid'] = testID;
        const style = typeof props.style === 'function' ? props.style({ pressed: false }) : props.style;
        attrs['data-style'] = JSON.stringify(flat(style));
        return createElement(tag, attrs, children);
    };
    return { View: el('div'), Text: el('span'), Pressable: el('button'), StyleSheet: { create: (s: unknown) => s } };
});
const pushed = vi.hoisted(() => ({ to: [] as unknown[] }));
vi.mock('expo-router', () => ({ router: { push: (to: unknown) => { pushed.to.push(to); } } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), vault: false }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('../vault', () => ({ vaultSignInCopyKnown: vi.fn(async () => mem.vault) }));
vi.mock('../node-post', () => ({ signedGet: vi.fn() }));

const { WayBackBellLine } = await import('../../components/WayBackBellLine');
const { oneWayBackStoreKey, wordsWrittenDownStoreKey } = await import('../storage-keys');
const { COLOUR_SETS } = await import('../../constants/colors');
const { PSEUDO_LANG, pseudoLocalise, setLanguage } = await import('@beanpool/core');

const KEY = 'a'.repeat(64);
const NOW = Date.parse('2026-11-21T02:00:00Z');
const URL_A = 'https://riverside.example';

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    mem.async.clear();
    mem.vault = false;
    pushed.to.length = 0;
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    setLanguage('en');
});
async function draw(node: ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(node as Parameters<Root['render']>[0]); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const styleOf = (e: Element | null) => JSON.parse(e?.getAttribute('data-style') ?? '{}') as Record<string, any>;
const line = () => host?.querySelector('[data-testid="bell-way-back"]') ?? null;
const record = (over: Record<string, unknown>) => mem.async.set(oneWayBackStoreKey(KEY), JSON.stringify({ url: URL_A, joinedAt: NOW - 3 * 86_400_000, ...over }));

function contrast(fg: string, bg: string): number {
    const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('when the line is there', () => {
    it.each([
        ['put away, nothing kept: the line', { dismissedAt: NOW - 86_400_000 }, {}, true],
        ['still up on Home (never put away): no line, the card says it', {}, {}, false],
        ['done (a sign-in added, or I still have my 12 words): no line', { dismissedAt: NOW - 86_400_000, done: 'checked' }, {}, false],
        ['a sign-in\'s copy at the key vault: no line', { dismissedAt: NOW - 86_400_000 }, { vault: true }, false],
        ['the words said written down in Ways back: no line', { dismissedAt: NOW - 86_400_000 }, { written: '1' }, false],
        ['taken back in Ways back: the line again', { dismissedAt: NOW - 86_400_000 }, { written: '0' }, true],
    ] as const)('%s', async (_name, rec, over, shown) => {
        record(rec);
        mem.vault = 'vault' in over ? !!over.vault : false;
        if ('written' in over) mem.async.set(wordsWrittenDownStoreKey(KEY), over.written as string);
        await draw(createElement(WayBackBellLine, { publicKey: KEY, colors: COLOUR_SETS.light }));
        expect(line() !== null).toBe(shown);
    });

    it('no reminder on this phone, or no account: nothing', async () => {
        await draw(createElement(WayBackBellLine, { publicKey: KEY, colors: COLOUR_SETS.light }));
        expect(line()).toBeNull();
        act(() => root?.unmount());
        host?.remove();
        record({ dismissedAt: NOW - 86_400_000 });
        await draw(createElement(WayBackBellLine, { publicKey: null, colors: COLOUR_SETS.light }));
        expect(line()).toBeNull();
    });
});

describe('the line drawn in every colour set, at 320 dp with 1.3x text', () => {
    for (const [set, colors] of Object.entries(COLOUR_SETS)) {
        it(`${set}: readable words and link on the sheet, a 44 dp target, a wrapping row`, async () => {
            record({ dismissedAt: NOW - 86_400_000 });
            await draw(createElement('div', { style: { width: 320, fontSize: '130%' } }, createElement(WayBackBellLine, { publicKey: KEY, colors })));
            const row = line();
            expect(row).not.toBeNull();
            expect(styleOf(row)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
            const words = row!.querySelector('span');
            expect(words?.textContent).toBe('No way back in yet.');
            const link = row!.querySelector('[role="button"]');
            expect(link?.getAttribute('aria-label')).toBe('Keep one');
            expect(link?.textContent).toBe('Keep one ›');
            expect(styleOf(link).minHeight).toBeGreaterThanOrEqual(44);
            const sheet = colors.surface.card;
            expect(contrast(styleOf(words).color, sheet), `${set} words`).toBeGreaterThanOrEqual(4.5);
            expect(contrast(styleOf(link!.querySelector('span')).color, sheet), `${set} link`).toBeGreaterThanOrEqual(4.5);
        });
    }

    it('every word through t(): the pseudo-locale draws its brackets', async () => {
        setLanguage(PSEUDO_LANG);
        record({ dismissedAt: NOW - 86_400_000 });
        await draw(createElement(WayBackBellLine, { publicKey: KEY, colors: COLOUR_SETS.light }));
        expect(line()?.textContent).toContain(pseudoLocalise('No way back in yet.'));
        expect(line()?.textContent).toContain(pseudoLocalise('Keep one'));
    });
});

describe('Keep one', () => {
    it('opens Account Protection and closes the sheet', async () => {
        record({ dismissedAt: NOW - 86_400_000 });
        const onOpen = vi.fn();
        await draw(createElement(WayBackBellLine, { publicKey: KEY, colors: COLOUR_SETS.light, onOpen }));
        await act(async () => { (line()!.querySelector('[role="button"]') as HTMLButtonElement).click(); });
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(pushed.to).toEqual([{ pathname: '/(tabs)/settings', params: { section: 'protection' } }]);
    });
});
