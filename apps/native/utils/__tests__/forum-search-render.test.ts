// @vitest-environment jsdom
/**
 * The forum's search box on the phone (slice F6; components/forum/ForumSearch.tsx, utils/forum-search.ts), rendered for real
 * over a stand-in for the node's route (apps/server/src/routes/forum.ts GET /api/forum/search), in the light and dark looks.
 *
 * - Nothing is asked while the member types; the keyboard's search key or the arrow asks once, with the words trimmed (each
 *   search is one of their 100 a day).
 * - A hit is a small card: its topic's title (or "A removed topic"), who wrote the post, its section, when, and its words
 *   around the find; a tap anywhere opens the topic at that post.
 * - Nothing found says so; the node's refusal (the day's searches spent) is shown in its own words.
 * - "Show more results" asks the next page and adds it under the first; ✕ clears the search and gives the list back.
 * - Colours come from the theme's tokens, in both looks.
 *
 * Slice F3 draws it at the top of the Forum's list (components/forum/ForumPane.tsx); until then nothing on main renders it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { button: 'button', alert: 'alert' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled, testID, value, onChangeText, onSubmitEditing, placeholder, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (disabled) attrs['data-disabled'] = 'true';
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (onSubmitEditing) attrs.onKeyDown = (e: { key: string }) => { if (e.key === 'Enter') onSubmitEditing(); };
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        const flat = Object.assign({}, ...[props.style].flat(3).filter((x) => x && typeof x === 'object'));
        if (flat.backgroundColor) attrs['data-bg'] = flat.backgroundColor;
        if (flat.color) attrs['data-color'] = flat.color;
        if (typeof flat.minHeight === 'number') attrs['data-min-height'] = String(flat.minHeight);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'), ActivityIndicator: el('progress'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
    };
});
vi.mock('@expo/vector-icons', async () => {
    const { createElement: h } = await import('react');
    return { MaterialCommunityIcons: ({ name }: { name: string }) => h('i', { 'data-icon': name }) };
});
const look = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const now = () => (look.dark ? { theme: 'dark', colors: darkColors } : { theme: 'light', colors: lightColors });
    return { useTheme: () => now(), useStyles: (make: (t: unknown) => unknown) => make(now()) };
});
const node = vi.hoisted(() => ({ asked: [] as { q: string; offset: number }[], answer: null as null | ((q: string, offset: number) => unknown) }));
vi.mock('../forum-search', () => ({
    searchForum: vi.fn(async (q: string, offset = 0) => {
        node.asked.push({ q, offset });
        const out = node.answer!(q, offset);
        if (out instanceof Error) throw out;
        return out;
    }),
}));

import { ForumSearch } from '../../components/forum/ForumSearch';
import { lightColors, darkColors } from '../../constants/colors';

const AT = new Date(Date.now() - 2 * 3600_000).toISOString();
const hit = (number: number, over: Record<string, unknown> = {}) => ({
    topicId: 'ft-1', sectionId: 's-general', title: 'Seed swap by the river', postId: `fp-${number}`, number,
    writer: { publicKey: 'sue-key', name: 'Sue' }, createdAt: AT, excerpt: `I can bring basil cuttings ${number}.`, ...over,
});

let root: Root | null = null;
let host: HTMLDivElement;
const opened: [string, number][] = [];
const showing: boolean[] = [];
async function draw(): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(createElement(ForumSearch, {
            onOpen: (id: string, n: number) => opened.push([id, n]),
            onShowing: (s: boolean) => showing.push(s),
            sectionName: (id: string) => (id === 's-general' ? 'General' : ''),
        }) as unknown as Parameters<Root['render']>[0]);
    });
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const all = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
async function type(text: string): Promise<void> {
    const input = q('forum-search-box') as HTMLInputElement;
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
async function press(el: HTMLElement | null): Promise<void> {
    expect(el).not.toBeNull();
    await act(async () => { el!.click(); });
}
async function searchKey(): Promise<void> {
    await act(async () => { q('forum-search-box')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
}

beforeEach(() => {
    node.asked.length = 0;
    node.answer = () => ({ hits: [hit(2), hit(1, { title: '', writer: { publicKey: 'mel-key', name: 'Mel' }, excerpt: 'Bring jars.' })], next: null });
    opened.length = 0;
    showing.length = 0;
    look.dark = false;
});
afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
});

describe('the forum search box on the phone', () => {
    it('asks nothing while they type; the search key asks once, trimmed; each hit is a card that opens its topic at the post', async () => {
        await draw();
        expect(q('forum-search-box')?.getAttribute('placeholder')).toBe('Search the forum');
        await type('  basil  ');
        expect(node.asked).toEqual([]);
        await searchKey();
        expect(node.asked).toEqual([{ q: 'basil', offset: 0 }]);
        const hits = all('forum-search-hit');
        expect(hits).toHaveLength(2);
        expect(hits[0].textContent).toContain('Seed swap by the river');
        expect(hits[0].textContent).toContain('Sue · General · ');
        expect(hits[0].textContent).toContain('I can bring basil cuttings 2.');
        // A topic its writer removed, its replies kept: the node sends no title.
        expect(hits[1].textContent).toContain('A removed topic');
        expect(showing).toEqual([true]);
        await press(hits[0]);
        expect(opened).toEqual([['ft-1', 2]]);
    });

    it('the arrow asks too; nothing found says so; a refusal shows the node\'s words', async () => {
        node.answer = () => ({ hits: [], next: null });
        await draw();
        expect(q('forum-search-go')?.getAttribute('data-disabled')).toBe('true');
        await type('zebra');
        await press(q('forum-search-go'));
        expect(q('forum-search-none')?.textContent).toBe('Nothing in the forum has every word of “zebra”.');
        node.answer = () => Object.assign(new Error('You can search the forum 100 times in any 24 hours. Try again later.'), { status: 429, code: 'searches_per_day' });
        await type('beans');
        await searchKey();
        expect(q('forum-search-failed')?.textContent).toBe('You can search the forum 100 times in any 24 hours. Try again later.');
    });

    it('Show more results adds the next page under the first; ✕ clears it and gives the list back', async () => {
        node.answer = (_q, offset) => (offset === 0
            ? { hits: Array.from({ length: 20 }, (_, i) => hit(i + 2)), next: 20 }
            : { hits: [hit(40)], next: null });
        await draw();
        await type('basil');
        await searchKey();
        expect(all('forum-search-hit')).toHaveLength(20);
        await press(q('forum-search-more'));
        expect(node.asked).toEqual([{ q: 'basil', offset: 0 }, { q: 'basil', offset: 20 }]);
        expect(all('forum-search-hit')).toHaveLength(21);
        expect(q('forum-search-more')).toBeNull();
        await press(q('forum-search-clear'));
        expect(all('forum-search-hit')).toHaveLength(0);
        expect((q('forum-search-box') as HTMLInputElement).value).toBe('');
        expect(showing).toEqual([true, true, false]);
    });

    it('draws from the theme\'s tokens in the light and the dark look, with 44 dp targets', async () => {
        for (const dark of [false, true]) {
            look.dark = dark;
            const colors = dark ? darkColors : lightColors;
            await draw();
            await type('basil');
            await searchKey();
            const box = q('forum-search-box')!.parentElement!;
            expect(box.getAttribute('data-bg')).toBe(colors.surface.subtle);
            expect(q('forum-search-box')!.getAttribute('data-color')).toBe(colors.text.body);
            expect(all('forum-search-hit')[0].querySelector('span')!.getAttribute('data-color')).toBe(colors.text.body);
            expect(Number(q('forum-search-clear')!.getAttribute('data-min-height'))).toBeGreaterThanOrEqual(44);
            expect(Number(all('forum-search-hit')[0].getAttribute('data-min-height'))).toBeGreaterThanOrEqual(44);
            await act(async () => root?.unmount());
            root = null;
            host.remove();
        }
    });
});
