// @vitest-environment jsdom
/**
 * The forum for a visitor on the phone (slice F7, the apps' part; core forum-visitors.ts), as the web lobby's: the visitors'
 * Forum tab in Chat's place, a topic read only with Join to reply where the reply box would be, and the Home card "From the
 * forum". Rendered for real in each of the phone's three looks at 320 dp and 1.3x text, from the node's public answer.
 *
 * One table over (visitor on global, member on global, visitor on a local community) x (the forum has public topics / none /
 * no answer): what the card and the tab show. Never a join wall, never a false empty, never an empty card.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { contrastRatio, visitorForumShows, type ForumPublicAnswer } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, style, contentContainerStyle } = props;
        const resolved = typeof style === 'function' ? style({ pressed: false }) : style;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat([resolved, contentContainerStyle])) };
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, flatten: (s: unknown) => flat(s) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), Image: el('img'),
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ pushed: [] as unknown[], params: { id: 'ft-2' } as Record<string, string> }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => { nav.pushed.push(to); }, navigate: (to: unknown) => { nav.pushed.push(to); }, replace: (to: unknown) => { nav.pushed.push(to); }, back: () => {}, canGoBack: () => true },
    useLocalSearchParams: () => nav.params,
}));
const look = vi.hoisted(() => ({ colors: null as any, theme: 'dark' as string }));
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ theme: look.theme, colors: look.colors }),
    useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: look.theme, colors: look.colors, patternEnabled: false }),
}));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children, testID, style }: { children?: import('react').ReactNode; testID?: string; style?: unknown }) => createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(style ?? {}) }, children),
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
// The post's words as the members' forum draws them (its links are its own suite's): plain text here.
vi.mock('../../components/forum/ForumBits', () => ({
    ForumWords: ({ words, testID }: { words: string; testID?: string }) => createElement('span', { 'data-testid': testID, 'data-style': JSON.stringify({ color: look.colors.text.body }) }, words),
}));
const node = vi.hoisted(() => ({ holds: 'topics' as 'topics' | 'none' | 'unreachable', doors: 0 }));
vi.mock('../forum-public', async () => {
    const data = await import('./forum-visitor-fixture');
    const fail = () => { throw Object.assign(new Error('Network request failed'), {}); };
    return {
        getPublicForum: vi.fn(async () => (node.holds === 'unreachable' ? fail() : { sections: data.SECTIONS, topics: node.holds === 'topics' ? data.TOPICS : [], next: null })),
        getPublicSection: vi.fn(async () => (node.holds === 'unreachable' ? fail() : { section: data.SECTIONS[0], topics: node.holds === 'topics' ? data.TOPICS : [], next: null })),
        getPublicTopic: vi.fn(async (id: string) => (node.holds === 'unreachable' ? fail() : data.pageOf(id))),
        openVisitorDoor: vi.fn(async () => { node.doors += 1; }),
        visitorForumHere: vi.fn(async () => true),
        useVisitorForum: () => true,
    };
});
vi.mock('../use-guide', async () => {
    const { getBundledGuide } = await import('../guide');
    return { useGuide: () => ({ guide: getBundledGuide(), source: 'bundled' }) };
});

import { COLOUR_SETS } from '../../constants/colors';
import { ForumVisitorHomeBody } from '../../components/home/ForumVisitorHomeBody';
import { ForumVisitorPane } from '../../components/forum/ForumVisitorPane';
import ForumPublicTopicScreen from '../../app/forum-public/[id]';
import { cardsToDraw, cardCaption, type HomeAnswer } from '../home-cards';
import { isLookRoute } from '../look-around';
import { TOPICS } from './forum-visitor-fixture';

const LOOKS = [['Classic', 'dark'], ['Light', 'light'], ['Dark', 'night']] as const;
const GLOBAL = { forum: true, forumPublic: true, guestListingsOnly: true, beans: false };
const LOCAL = { forum: true, guestListingsOnly: true };
// The global community in a private preview: the server drops `forumPublic` (feat/forum-f7-server round 2, node-profile.ts),
// because a preview shows visitors nothing.
const PREVIEW = { forum: true, guestListingsOnly: true, beans: false, openJoin: false, wordsDoor: false, privatePreview: true };

async function draw(element: unknown, set: keyof typeof COLOUR_SETS = 'dark'): Promise<HTMLElement> {
    look.colors = COLOUR_SETS[set];
    look.theme = set;
    const host = document.createElement('div');
    host.setAttribute('data-style', JSON.stringify({ backgroundColor: COLOUR_SETS[set].surface.page }));
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(element as any); });
    await act(async () => {});
    await act(async () => {});
    return host;
}
const all = (host: ParentNode, id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const one = (host: ParentNode, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const words = (n: Element | null) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();
const styleOf = (n: Element) => JSON.parse(n.getAttribute('data-style') ?? '{}');
const frame = (body: unknown) => createElement('section', { 'data-testid': 'card-frame', 'data-style': JSON.stringify({ backgroundColor: look.colors.surface.card }) }, body as any);

/** Every word in readable ink on its ground (4.5:1); every tappable 44 dp or more; no width fixed on words. */
function expectReadableAndHeld(host: HTMLElement) {
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
        expect(contrastRatio(ink!, ground!), `${words(span)} (${ink} on ${ground})`).toBeGreaterThanOrEqual(4.5);
        checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
    for (const n of Array.from(host.querySelectorAll('span, button, div'))) {
        const s = styleOf(n);
        if (typeof s.width === 'number' && words(n)) throw new Error(`fixed width on "${words(n).slice(0, 40)}"`);
    }
    for (const b of Array.from(host.querySelectorAll('button')) as HTMLElement[]) {
        const s = styleOf(b);
        expect(Math.max(s.minHeight ?? 0, s.height ?? 0), words(b)).toBeGreaterThanOrEqual(40);
    }
}

beforeEach(() => {
    document.body.innerHTML = '';
    nav.pushed = [];
    nav.params = { id: 'ft-2' };
    node.holds = 'topics';
    node.doors = 0;
});

describe("who sees the visitors' forum: the table (card + tab)", () => {
    const answerOf = (features: Record<string, unknown>, member: boolean): HomeAnswer => ({
        generatedAt: new Date().toISOString(), profile: 'global', features, layout: null, layoutV1: null,
        me: member ? { publicKey: 'a'.repeat(64), interests: [], tour: { ended: true } } : null,
        cards: { market: { items: [{ id: 'p1', type: 'offer', title: 'Seedlings', category: 'garden', photoUrl: null }], total14d: 1, more: false }, community: { name: null, members: 20, communities: 3 } },
    } as unknown as HomeAnswer);
    const readers = [
        ['a visitor on the global community', 'visitor', GLOBAL],
        ['a member of the global community', 'member', GLOBAL],
        ['a visitor on a local community', 'visitor', LOCAL],
        ['a visitor on the global community in a private preview', 'visitor', PREVIEW],
    ] as const;
    for (const [who, reader, features] of readers) {
        for (const answer of ['topics', 'none', 'unreachable'] as ForumPublicAnswer[]) {
            it(`${who}, the forum has ${answer === 'topics' ? 'public topics' : answer === 'none' ? 'none public' : 'no answer'}`, () => {
                const shows = visitorForumShows(reader, features, answer);
                const home = answerOf(features, reader === 'member');
                const cards = cardsToDraw(home, null, { interests: [], safetyUp: false } as any).map((c) => c.type);
                if (reader === 'visitor' && features === GLOBAL) {
                    expect(shows).toEqual({ tab: true, card: answer === 'topics' ? 'topics' : 'guide' });
                    // Third, after the Market card: beside "Near you" and "What people post"; called "From the forum".
                    expect(cards[cards.indexOf('market') + 1]).toBe('forum');
                    expect(cardCaption('forum', home)).toBe('From the forum');
                } else {
                    expect(shows).toEqual({ tab: false, card: null });
                    if (reader === 'visitor') expect(cards).not.toContain('forum');
                    // A member's own Forum card (if they add it) keeps its own name.
                    else expect(cardCaption('forum', home)).toBe('Forum');
                }
            });
        }
    }

    it("the tab bar: the Forum in Chat's place for a visitor only; a phone with no account may stay on it and on a topic", () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/_layout.tsx'), 'utf-8');
        const chats = src.slice(src.indexOf('name="chats"'), src.indexOf('name="chats"') + 200);
        expect(chats).toMatch(/\.\.\.\(visitorForum \? \{ href: null \} : \{\}\)/);
        const forum = src.slice(src.indexOf('name="visitor-forum"'), src.indexOf('name="visitor-forum"') + 200);
        expect(forum).toMatch(/\.\.\.\(visitorForum \? \{\} : \{ href: null \}\)/);
        expect(isLookRoute(['(tabs)', 'visitor-forum'])).toBe(true);
        expect(isLookRoute(['forum-public', '[id]'])).toBe(true);
        // The members' forum stays an account's.
        expect(isLookRoute(['forum', '[id]'])).toBe(false);
        expect(isLookRoute(['(tabs)', 'chats'])).toBe(false);
    });
});

describe('the Home card "From the forum"', () => {
    for (const [name, set] of LOOKS) {
        it(`${name}: the three newest public topics with first line and section; a tap opens it read only; Open the forum`, async () => {
            const host = await draw(createElement(ForumVisitorHomeBody, { colors: COLOUR_SETS[set], features: GLOBAL, frame }), set);
            const rows = all(host, 'home-forum-visitor-topic');
            expect(rows.map((r) => words(r.querySelector('span')))).toEqual(['A tool library in a shed', 'Seed swap ideas', 'Starting small']);
            expect(words(rows[0])).toContain('We share tools for ft-2.');
            expect(words(rows[0])).toContain('Seed swaps');
            await act(async () => { rows[1].click(); });
            expect(nav.pushed).toContainEqual({ pathname: '/forum-public/[id]', params: { id: 'ft-3' } });
            await act(async () => { one(host, 'home-forum-visitor-open')!.click(); });
            expect(nav.pushed).toContainEqual('/(tabs)/visitor-forum');
            expectReadableAndHeld(one(host, 'card-frame')!.parentElement as HTMLElement);
        });
    }

    for (const holds of ['none', 'unreachable'] as const) {
        it(`${holds === 'none' ? 'no public topic' : 'no answer'}: the guide's How BeanPool works, never an empty card or "no topics"`, async () => {
            node.holds = holds;
            const host = await draw(createElement(ForumVisitorHomeBody, { colors: COLOUR_SETS.dark, features: GLOBAL, frame }));
            const guide = one(host, 'home-forum-visitor-guide');
            expect(words(guide)).toContain('How BeanPool works');
            expect(all(host, 'home-forum-visitor-topic')).toHaveLength(0);
            expect(words(one(host, 'card-frame'))).not.toMatch(/No topics/);
            await act(async () => { guide!.click(); });
            expect(nav.pushed).toContainEqual({ pathname: '/guide/[slug]', params: { slug: 'how-it-works' } });
        });
    }
});

describe("the visitors' Forum tab and a topic, read only", () => {
    for (const [name, set] of LOOKS) {
        it(`${name}: the list; a topic with its writers and words, and Join to reply where the reply box would be`, async () => {
            const list = await draw(createElement(ForumVisitorPane), set);
            expect(all(list, 'forum-visitor-topic-row').map((r) => words(r.querySelector('span')))).toEqual(TOPICS.map((x) => x.title));
            await act(async () => { all(list, 'forum-visitor-topic-row')[1].click(); });
            expect(nav.pushed).toContainEqual({ pathname: '/forum-public/[id]', params: { id: 'ft-2' } });
            expectReadableAndHeld(list);

            const topic = await draw(createElement(ForumPublicTopicScreen), set);
            expect(words(one(topic, 'forum-visitor-title'))).toBe('A tool library in a shed');
            expect(words(one(topic, 'forum-visitor-post-2'))).toContain('Dax · Riverside');
            expect(words(one(topic, 'forum-visitor-post-2'))).toContain('Count me in.');
            expect(topic.querySelector('textarea, input')).toBeNull();
            expect(words(one(topic, 'forum-visitor-join'))).toBe('Join to reply');
            await act(async () => { one(topic, 'forum-visitor-join')!.click(); });
            expect(node.doors).toBe(1);
            expectReadableAndHeld(topic);
        });
    }

    it('none public: says so, with the door (never a wall)', async () => {
        node.holds = 'none';
        const host = await draw(createElement(ForumVisitorPane));
        expect(words(one(host, 'forum-visitor-none'))).toBe('No topics here yet. Join to start the first one.');
        expect(one(host, 'forum-visitor-join')).not.toBeNull();
    });

    it('no answer: the forum\'s own "Couldn\'t load" with Try again, never "no topics"', async () => {
        node.holds = 'unreachable';
        const host = await draw(createElement(ForumVisitorPane));
        expect(words(one(host, 'forum-visitor-failed'))).toContain('Couldn’t load the forum');
        expect(one(host, 'forum-visitor-none')).toBeNull();
        node.holds = 'topics';
        await act(async () => { (one(host, 'forum-visitor-failed')!.querySelector('button') as HTMLElement).click(); });
        await act(async () => {});
        expect(all(host, 'forum-visitor-topic-row')).toHaveLength(4);
    });
});
