// @vitest-environment jsdom
/**
 * The Home card "Forum" on the phone (slice F3 part 2; components/home/ForumHomeBody.tsx, DESIGN-forums-fable.md §14), rendered
 * for real in each of the phone's three looks (Classic `dark`, Light `light`, Dark `night`) at the floor's window (320 dp, text
 * at 1.3x), on the card's own ground (surface.card), through Home's real rows and link (components/home/HomeParts.tsx).
 *
 * - The three newest topics, newest first (by when each was started; a removed one left out); a tap anywhere on a row opens
 *   the topic; ● on a followed topic with a reply not opened.
 * - "Open the forum ›" opens the Chat tab's Forum side.
 * - The kept list draws at once; with no connection and nothing kept, the forum's own line; no topics, the list's line.
 * - Read again at each of Home's own reads (back at Home, its poll, a pull: the `turn` Home hands it), so ● clears once the
 *   topic is read and a new topic shows; never on a render that changed nothing.
 * - Every word in readable ink on its ground (4.5:1), every tappable row 44 dp or more, no width fixed on words.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BRAND_SETS, contrastRatio } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, style } = props;
        const resolved = typeof style === 'function' ? style({ pressed: false }) : style;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(resolved)) };
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, flatten: (s: unknown) => flat(s) },
        View: el('div'), Text: el('span'), Pressable: el('button'), Image: el('img'),
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('expo-router', () => ({ router: { push: (to: unknown) => { nav.pushed.push(to); }, navigate: (to: unknown) => { nav.pushed.push(to); } } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
const node = vi.hoisted(() => ({ list: null as any, kept: null as any, offline: false }));
vi.mock('../forum', () => ({
    getForumTopics: vi.fn(async () => { if (node.offline) throw Object.assign(new Error(''), { unsaid: true }); return node.list; }),
    keptForumList: vi.fn(async () => node.kept),
}));

import { ForumHomeBody, newestForumTopics } from '../../components/home/ForumHomeBody';
import { COLOUR_SETS } from '../../constants/colors';

const LOOKS = [['Classic', 'dark'], ['Light', 'light'], ['Dark', 'night']] as const;
type Set = (typeof BRAND_SETS)[number];
const NOW = Date.parse('2026-11-15T10:00:00Z');
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const topicOf = (id: string, startedHoursAgo: number, over: Record<string, unknown> = {}) => ({
    id, sectionId: 'skills', title: `How do we share tools between neighbours on our street? (${id})`, writer: { publicKey: 'a'.repeat(64), name: 'Asha' }, place: null,
    lang: 'en', replyCount: 2, lastActivityAt: at(0.5), createdAt: at(startedHoursAgo), pinned: false, closed: null, removed: false, hidden: false, follow: null, unread: false, ...over,
});
// The list's order (pinned first, then the newest activity) is not the card's: it shows the newest started.
const LIST = {
    topics: [
        topicOf('pinned-old', 400, { pinned: true, title: 'Welcome: start here' }),
        topicOf('t2', 30),
        topicOf('t1', 5, { unread: true, follow: 'following' }),
        topicOf('gone', 1, { removed: true, title: '' }),
        topicOf('t3', 50),
        topicOf('t4', 90),
    ],
    next: null,
};

async function render(set: Set): Promise<HTMLElement> {
    const host = document.createElement('div');
    // The card's own ground: Home's card frame draws on surface.card.
    host.setAttribute('data-style', JSON.stringify({ backgroundColor: COLOUR_SETS[set].surface.card }));
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(ForumHomeBody, { colors: COLOUR_SETS[set], now: NOW }) as unknown as Parameters<Root["render"]>[0]); });
    await act(async () => {});
    return host;
}
const all = (host: ParentNode, id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const styleOf = (n: Element) => JSON.parse(n.getAttribute('data-style') ?? '{}');
const words = (n: Element | null) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();

function expectReadable(host: HTMLElement) {
    let checked = 0;
    for (const span of Array.from(host.querySelectorAll('span'))) {
        if (!words(span) || span.querySelector('span')) continue;
        let ink: string | undefined;
        let ground: string | undefined;
        for (let n: Element | null = span; n; n = n.parentElement) {
            const s = styleOf(n);
            if (!ink && s.color) ink = s.color;
            if (!ground && s.backgroundColor) ground = s.backgroundColor;
            if (n === host) break;
        }
        expect(ink, words(span)).toBeTruthy();
        expect(contrastRatio(ink!, ground!), `${words(span)} (${ink} on ${ground})`).toBeGreaterThanOrEqual(4.5);
        checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
}
function expectHoldsSmall(host: HTMLElement) {
    for (const n of Array.from(host.querySelectorAll('span, button, div'))) {
        const s = styleOf(n);
        if (typeof s.width === 'number' && words(n)) throw new Error(`fixed width on "${words(n).slice(0, 40)}"`);
    }
    for (const b of Array.from(host.querySelectorAll('button')) as HTMLElement[]) {
        const s = styleOf(b);
        expect(Math.max(s.minHeight ?? 0, s.height ?? 0), words(b)).toBeGreaterThanOrEqual(44);
    }
}

beforeEach(() => {
    document.body.innerHTML = '';
    nav.pushed = [];
    Object.assign(node, { list: LIST, kept: null, offline: false });
    vi.clearAllMocks();
});

describe('the newest topics', () => {
    it('three, newest started first, a removed one left out', () => {
        expect(newestForumTopics(LIST.topics as any).map((x) => x.id)).toEqual(['t1', 't2', 't3']);
        expect(newestForumTopics([])).toEqual([]);
    });
});

describe('Home reads the card again with its own reads', () => {
    it('app/(tabs)/index.tsx hands the card a turn that moves at Home\'s focus read (a return, the app back), its poll and a pull', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/index.tsx'), 'utf-8');
        expect(src).toMatch(/<ForumHomeBody[^>]*\bturn=\{homeTurn\}/);
        const refresh = src.slice(src.indexOf('const refresh = useCallback(async (why'));
        expect(refresh.slice(0, refresh.indexOf('\n    }, ['))).toMatch(/if \(why === 'focus' \|\| why === 'poll' \|\| why === 'pull'\) setHomeTurn\(\(n\) => n \+ 1\);/);
    });
});

describe.each(LOOKS)('the Home card "Forum" in %s (%s)', (_name, set) => {
    it('reads the forum again at each new turn of Home\'s: ● goes once the topic is read, a topic started since shows', async () => {
        const host = document.createElement('div');
        host.setAttribute('data-style', JSON.stringify({ backgroundColor: COLOUR_SETS[set].surface.card }));
        document.body.appendChild(host);
        const root = createRoot(host);
        const draw = async (turn: number) => {
            await act(async () => { root.render(createElement(ForumHomeBody, { colors: COLOUR_SETS[set], now: NOW, turn }) as unknown as Parameters<Root['render']>[0]); });
            await act(async () => {});
        };
        const { getForumTopics } = await import('../forum');
        await draw(1);
        const unread = () => all(host, 'home-forum-topic').map((r) => !!r.querySelector('[aria-label="New replies"]'));
        const ids = () => all(host, 'home-forum-topic').map((r) => r.getAttribute('aria-label')!.split('. ')[0]);
        expect(unread()).toEqual([true, false, false]);
        // Meanwhile the member read t1, and someone started a topic.
        node.list = { topics: [topicOf('t5', 0.2, { title: 'Seed swap on Saturday?' }), ...LIST.topics.map((x) => (x.id === 't1' ? { ...x, unread: false } : x))], next: null };
        // Home drawn again with nothing new (its many renders): nothing read.
        await draw(1);
        expect(getForumTopics).toHaveBeenCalledTimes(1);
        expect(unread()).toEqual([true, false, false]);
        // Home's next read: the card reads with it.
        await draw(2);
        expect(getForumTopics).toHaveBeenCalledTimes(2);
        expect(ids()).toEqual(['Seed swap on Saturday?', LIST.topics[2].title, LIST.topics[1].title]);
        expect(unread()).toEqual([false, false, false]);
        // A read again that finds no connection keeps what is drawn, never the line over it.
        node.offline = true;
        await draw(3);
        expect(ids()).toEqual(['Seed swap on Saturday?', LIST.topics[2].title, LIST.topics[1].title]);
        expect(words(host)).not.toContain('Couldn’t load the forum');
        await act(async () => { root.unmount(); });
    });

    it('the three newest topics, each row opening its topic; ● on the followed one; Open the forum › opens the Forum side', async () => {
        const host = await render(set);
        const rows = all(host, 'home-forum-topic');
        expect(rows.map((r) => r.getAttribute('aria-label')!.split('. ')[0])).toEqual([LIST.topics[2].title, LIST.topics[1].title, LIST.topics[4].title]);
        expect(words(rows[0])).toContain('Asha · 2 replies · 5 hours ago');
        expect(rows.map((r) => !!r.querySelector('[aria-label="New replies"]'))).toEqual([true, false, false]);
        await act(async () => { rows[1].click(); });
        expect(nav.pushed).toEqual([{ pathname: '/forum/[id]', params: { id: 't2' } }]);
        const open = all(host, 'home-forum-open')[0];
        expect(words(open)).toBe('Open the forum ›');
        await act(async () => { open.click(); });
        expect(nav.pushed.at(-1)).toEqual({ pathname: '/(tabs)/chats', params: { view: 'forum' } });
        expectReadable(host);
        expectHoldsSmall(host);
    });

    it('with no connection the kept list draws; with nothing kept, the forum\'s own line; no topics, the list\'s line', async () => {
        node.offline = true;
        node.kept = LIST;
        let host = await render(set);
        expect(all(host, 'home-forum-topic')).toHaveLength(3);
        document.body.innerHTML = '';
        node.kept = null;
        host = await render(set);
        expect(all(host, 'home-forum-topic')).toHaveLength(0);
        expect(words(host)).toContain('Couldn’t load the forum. Check your connection and try again.');
        expect(words(all(host, 'home-forum-open')[0])).toBe('Open the forum ›');
        expectReadable(host);
        document.body.innerHTML = '';
        node.offline = false;
        node.list = { topics: [], next: null };
        host = await render(set);
        expect(words(host)).toContain('No topics here yet. Start the first one.');
        expectReadable(host);
    });
});
