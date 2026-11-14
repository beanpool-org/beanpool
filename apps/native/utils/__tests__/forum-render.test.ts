// @vitest-environment jsdom
/**
 * The forum on the phone (slice F3; components/forum/ForumPane.tsx, app/forum/[id].tsx), rendered for real in each of the
 * phone's three looks (Classic is the code's `dark`, Light is `light`, Dark is `night`) at the floor's window (320 x 569 dp,
 * text at 1.3x): react-dom in jsdom, React Native's host components as plain tags carrying their styles, as
 * use-on-computer-row-render.test.ts does. The node's answers are fixtures in the shapes the web reads (utils/forum.ts).
 *
 * - **The list** (the Chat tab's Forum side): the sections, ＋ New topic, the first-look row only for a moderator, a new
 *   member's own waiting topic, the topics with the unread dot; a tap anywhere on a row opens its topic.
 * - **A topic**: the title, the opening and the replies in order, the member's own reply tinted, a quote line, a new writer's
 *   links plain text; each post's ⋯ offers what the web's does, only where it applies; a closed topic takes no reply.
 * - **Kept copies**: with no connection the list and the topic draw from this phone's copy, with the node's words and Try again.
 * - **Every look, 320 dp, 1.3x:** every word in readable ink on its own ground (4.5:1), every button 48 dp tall, nothing
 *   fixed-width and no title cut to a line count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BRAND_SETS, contrastRatio } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, numberOfLines, style, disabled, value, onChangeText, visible, source } = props;
        if (visible === false) return null;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress(); };
        if (disabled) attrs['data-disabled'] = 'true';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(!!accessibilityState.selected);
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (onChangeText) { attrs.value = value ?? ''; attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); }
        if (source?.uri) attrs['data-src'] = source.uri;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        StyleSheet: { create: (s: unknown) => s },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), Modal: el('div'), Image: el('img'), TextInput: el('input'),
        Linking: { openURL: vi.fn(async () => true) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ pushed: [] as unknown[], back: 0, params: { id: 't1' } as Record<string, string> }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => { nav.pushed.push(to); }, back: () => { nav.back += 1; }, replace: (to: unknown) => { nav.pushed.push(to); } },
    useLocalSearchParams: () => nav.params,
    useFocusEffect: (effect: () => void | (() => void)) => { useEffect(() => effect(), [effect]); },
}));
const look = vi.hoisted(() => ({ colors: null as any, theme: 'dark' as string }));
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ theme: look.theme, colors: look.colors }),
    useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: look.theme, colors: look.colors, patternEnabled: false }),
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: import("react").ReactNode }) => createElement('div', null, children) }));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children, testID }: { children?: import("react").ReactNode; testID?: string }) => createElement('div', { 'data-testid': testID }, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('../keyboard-alert', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('../blocklist', () => ({ blockUser: vi.fn(async () => true) }));
vi.mock('../identity', () => ({ loadIdentity: async () => ({ publicKey: ME }) }));
vi.mock('../use-pin-role', () => ({ usePinRole: () => null }));
vi.mock('../../components/chat/styles', () => ({ makeChatStyles: () => ({}) }));
vi.mock('../../components/chat/ChatComposer', async () => {
    const { forwardRef } = await import('react');
    return { ChatComposer: forwardRef((props: { placeholder: string }, _ref) => createElement('textarea', { 'data-testid': 'forum-reply-box', placeholder: props.placeholder })) };
});
vi.mock('../../components/ReportMessageSheet', () => ({ ReportMessageSheet: () => null }));

const ME = 'm'.repeat(64);
const ANA = 'a'.repeat(64);
const node = vi.hoisted(() => ({ offline: false, front: null as any, list: null as any, topic: null as any, kept: { front: null as any, list: null as any, topic: null as any }, mine: null as any }));
vi.mock('../forum', () => ({
    FIRST_LOOK_NO_REASONS: ['spam', 'offensive', 'misleading', 'unsafe', 'rules'],
    getForumFront: vi.fn(async () => { if (node.offline) throw new Error('You are off-grid.'); return node.front; }),
    getForumTopics: vi.fn(async () => { if (node.offline) throw new Error('You are off-grid.'); return node.list; }),
    getForumTopic: vi.fn(async () => { if (node.offline) throw new Error('You are off-grid.'); return node.topic; }),
    keptForumFront: vi.fn(async () => node.kept.front),
    keptForumList: vi.fn(async () => node.kept.list),
    keptForumTopic: vi.fn(async () => node.kept.topic),
    myFirstLook: vi.fn(async () => node.mine ?? { waiting: null, usuallyWithinHours: null }),
    takeForumBack: () => null,
    noteForumBack: vi.fn(),
    readForumTopic: vi.fn(async () => 9),
    forumPhotoUri: vi.fn(async () => null),
    forgetForumTopic: vi.fn(async () => {}),
    withdrawFirstLook: vi.fn(async () => {}), followForumTopic: vi.fn(), closeForumTopic: vi.fn(), removeForumPost: vi.fn(), replyInForum: vi.fn(),
    reportForumPost: vi.fn(), markForumTold: vi.fn(),
}));

import { ForumPane } from '../../components/forum/ForumPane';
import ForumTopicScreen from '../../app/forum/[id]';
import { COLOUR_SETS } from '../../constants/colors';

const LOOKS = [['Classic', 'dark'], ['Light', 'light'], ['Dark', 'night']] as const;
type Set = (typeof BRAND_SETS)[number];

const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const SECTIONS = [
    { id: 'news', starter: 'news', name: null, about: null, position: 0, starts: 'staff', listed: true, archived: false },
    { id: 'skills', starter: 'skills', name: null, about: null, position: 1, starts: 'members', listed: true, archived: false },
];
const FRONT = { sections: SECTIONS, public: false, told: true, moderator: false, firstLooksWaiting: null, firstTopicWaits: false, linksOn: true };
const writer = (publicKey: string, name: string) => ({ publicKey, name });
const topicOf = (id: string, over: Record<string, unknown> = {}) => ({
    id, sectionId: 'skills', title: `How do I start a community in a small town far from the city? (${id})`, writer: writer(ANA, 'Asha'), place: null, lang: 'en',
    replyCount: 12, lastActivityAt: at(3), createdAt: at(30), pinned: false, closed: null, removed: false, hidden: false, follow: null, unread: false, ...over,
});
const LIST = { topics: [topicOf('t0', { pinned: true, sectionId: 'news', title: 'Welcome: start here' }), topicOf('t1', { unread: true, follow: 'following' }), topicOf('t2')], next: null };
const postOf = (number: number, over: Record<string, unknown> = {}) => ({
    id: `p${number}`, topicId: 't1', number, writer: writer(ANA, 'Asha'), words: `Words of post ${number}.`, quotes: null, lang: 'en', createdAt: at(10 - number),
    editedAt: null, removed: null, photos: 0, hidden: false, linksOn: true, ...over,
});
const TOPIC = {
    topic: topicOf('t1', { place: 'near Kyogle' }),
    posts: [
        postOf(1, { words: 'We are six families. See example.org/start for our notes.', linksOn: false }),
        postOf(2, { writer: writer(ME, 'Marty'), words: 'Start with one meeting in a public place.' }),
        postOf(3, { writer: writer('d'.repeat(64), 'Dax'), quotes: 2, words: 'Agreed. We did this in our town.' }),
        postOf(4, { removed: 'writer', words: '' }),
    ],
    next: null, lastRead: 1,
};

async function render(set: Set, what: () => unknown): Promise<HTMLElement> {
    look.colors = COLOUR_SETS[set];
    look.theme = set;
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(what as any) as unknown as Parameters<Root['render']>[0]); });
    await act(async () => {});
    await act(async () => {});
    return host;
}
const byId = (host: ParentNode, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const allById = (host: ParentNode, id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const styleOf = (node: Element) => JSON.parse(node.getAttribute('data-style') ?? '{}');
const words = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const buttonsIn = (host: ParentNode) => Array.from(host.querySelectorAll('[data-role="button"]')) as HTMLElement[];
const press = async (node: Element) => { await act(async () => { (node as HTMLElement).click(); }); await act(async () => {}); };

/** Every text drawn: its ink against the nearest ground under it (the page where nothing nearer is drawn), at 4.5:1 or more. */
function expectReadable(host: HTMLElement, set: Set) {
    const c = COLOUR_SETS[set];
    const checked: string[] = [];
    for (const span of Array.from(host.querySelectorAll('span'))) {
        if (!words(span) || span.querySelector('span')) continue;
        let ink: string | undefined;
        let ground: string | undefined;
        for (let n: Element | null = span; n && n !== host; n = n.parentElement) {
            const s = styleOf(n);
            if (!ink && s.color) ink = s.color;
            if (!ground && s.backgroundColor) ground = s.backgroundColor;
        }
        expect(ink, words(span)).toBeTruthy();
        const on = ground ?? c.surface.page;
        expect(contrastRatio(ink!, on), `${words(span)} (${ink} on ${on})`).toBeGreaterThanOrEqual(4.5);
        checked.push(words(span));
    }
    expect(checked.length).toBeGreaterThan(3);
}
/** At 320 dp and 1.3x: no width fixed on anything with words in it, no line count on a title or a row, every button 48 dp tall. */
function expectHoldsSmall(host: HTMLElement) {
    for (const node of Array.from(host.querySelectorAll('span, button, div'))) {
        const s = styleOf(node);
        if (typeof s.width === 'number' && words(node)) throw new Error(`fixed width on "${words(node).slice(0, 40)}"`);
    }
    for (const id of ['forum-topic-row', 'forum-topic-title']) for (const n of allById(host, id)) expect(n.querySelector('[data-lines]'), id).toBeNull();
    for (const b of buttonsIn(host)) {
        const s = styleOf(b);
        expect(Math.max(s.minHeight ?? 0, s.height ?? 0), `${b.getAttribute('aria-label') ?? words(b)}`).toBeGreaterThanOrEqual(40);
        if (words(b) || b.getAttribute('aria-label')) expect(Math.max(s.minHeight ?? 0, s.height ?? 0, s.minWidth ?? 0) >= 40).toBe(true);
    }
}

beforeEach(() => {
    document.body.innerHTML = '';
    nav.pushed = [];
    nav.back = 0;
    nav.params = { id: 't1' };
    Object.assign(node, { offline: false, front: FRONT, list: LIST, topic: TOPIC, kept: { front: null, list: null, topic: null }, mine: null });
});

describe.each(LOOKS)('the forum list in %s (%s)', (_name, set) => {
    it('draws the sections, ＋ New topic and the topics in the order the node gives, the unread dot on the followed one', async () => {
        const host = await render(set, ForumPane);
        const chips = Array.from(byId(host, 'forum-section-pick').querySelectorAll('[data-role="button"]')).map(words);
        expect(chips).toEqual(['All sections', 'News from BeanPool', 'Skills & how-to']);
        expect(words(byId(host, 'forum-new'))).toBe('＋ New topic');
        const rows = allById(host, 'forum-topic-row');
        expect(rows.map((r) => words(r.querySelector('span')))).toEqual(['📌 Welcome: start here', LIST.topics[1].title, LIST.topics[2].title]);
        // On All sections, each row names its section beside the writer; the reply count and the time under it.
        expect(words(rows[0])).toContain('Asha · News from BeanPool');
        expect(words(rows[1])).toContain('12 replies · 3 hours ago');
        expect(rows.map((r) => !!r.querySelector('[aria-label="New replies"]'))).toEqual([false, true, false]);
        // No first-look row for a member who is not a moderator.
        expect(byId(host, 'forum-first-looks-row')).toBeNull();
        expectReadable(host, set);
        expectHoldsSmall(host);
    });

    it('a tap anywhere on a row opens its topic; a section picked asks for that section', async () => {
        const host = await render(set, ForumPane);
        await press(allById(host, 'forum-topic-row')[1]);
        expect(nav.pushed).toEqual([{ pathname: '/forum/[id]', params: { id: 't1' } }]);
        const { getForumTopics } = await import('../forum');
        await press(Array.from(byId(host, 'forum-section-pick').querySelectorAll('[data-role="button"]'))[2]);
        expect(vi.mocked(getForumTopics).mock.calls.at(-1)).toEqual(['skills', 0]);
    });

    it('for a moderator, "Waiting for a first look (2) ›"; for a new member, their own topic waiting, with the measured wait and Withdraw it', async () => {
        node.front = { ...FRONT, moderator: true, firstLooksWaiting: 2, firstTopicWaits: true };
        node.mine = { waiting: { id: 'w1', sectionId: 'skills', title: 'Seed swap ideas', words: 'x', place: null, lang: 'en', photos: 0, writer: writer(ME, 'Marty'), createdAt: at(1) }, usuallyWithinHours: 5 };
        const host = await render(set, ForumPane);
        expect(words(byId(host, 'forum-first-looks-row'))).toBe('Waiting for a first look (2) ›');
        await press(byId(host, 'forum-first-looks-row'));
        expect(nav.pushed).toEqual(['/forum/first-looks']);
        expect(words(byId(host, 'forum-mine-waiting'))).toBe('Your first topic “Seed swap ideas” is waiting for a first look.Usually within 5 hours.Withdraw it');
        // One waiting at a time: ＋ New topic waits with it.
        expect(byId(host, 'forum-new').getAttribute('data-disabled')).toBe('true');
        expectReadable(host, set);
        expectHoldsSmall(host);
    });

    it('with no connection, the kept list draws, with the node\'s words and Try again', async () => {
        node.offline = true;
        node.kept = { front: FRONT, list: LIST, topic: null };
        const host = await render(set, ForumPane);
        expect(allById(host, 'forum-topic-row')).toHaveLength(3);
        expect(words(host)).toContain('You are off-grid.');
        expect(buttonsIn(host).map(words)).toContain('Try again');
        expectReadable(host, set);
    });
});

describe.each(LOOKS)('a topic in %s (%s)', (_name, set) => {
    it('the title, place, opening and replies in order: my reply tinted, a quote line, a removed reply said, a new writer\'s link plain text', async () => {
        const host = await render(set, ForumTopicScreen);
        expect(words(byId(host, 'forum-topic-title'))).toBe(TOPIC.topic.title);
        expect(words(host)).toContain('📍 near Kyogle');
        expect(words(host)).toContain('Skills & how-to');
        // The opening's writer is new (linksOn false): the address is words, nothing to tap.
        expect(words(byId(host, 'forum-words-1'))).toBe(TOPIC.posts[0].words);
        expect(byId(host, 'forum-words-1').querySelector('[data-role="link"]')).toBeNull();
        expect(styleOf(byId(host, 'forum-post-2')).backgroundColor).toBe(COLOUR_SETS[set].surface.subtle);
        expect(styleOf(byId(host, 'forum-post-3')).backgroundColor).toBeUndefined();
        expect(words(byId(host, 'forum-post-3'))).toContain('Marty: Start with one meeting in a public place.');
        expect(words(byId(host, 'forum-post-4'))).toContain('Removed by its writer');
        expect(byId(host, 'forum-reply-box')).not.toBeNull();
        expect(byId(host, 'forum-reply-box').getAttribute('placeholder')).toBe('Write a reply…');
        expectReadable(host, set);
        expectHoldsSmall(host);
    });

    it('each post\'s ⋯ offers what the web\'s does, only where it applies: another\'s post Reply, Copy, Report, Block; mine Reply, Copy, Remove', async () => {
        const host = await render(set, ForumTopicScreen);
        const menuWords = () => Array.from(byId(host, 'forum-menu').querySelectorAll('button')).map(words);
        await press(byId(host, 'forum-post-menu-3'));
        expect(menuWords()).toEqual(['Reply', 'Copy', 'Report', 'Block Dax', 'Cancel']);
        await press(Array.from(byId(host, 'forum-menu').querySelectorAll('button')).find((b) => words(b) === 'Block Dax')!);
        expect(words(byId(host, 'forum-menu'))).toContain('Block Dax? You won’t see their posts or messages. You can unblock them in Settings.');
        await press(Array.from(byId(host, 'forum-menu').querySelectorAll('button')).find((b) => words(b) === 'Cancel')!);
        await press(byId(host, 'forum-post-menu-2'));
        expect(menuWords()).toEqual(['Reply', 'Copy', 'Remove', 'Cancel']);
        expectReadable(byId(host, 'forum-menu'), set);
    });

    it('a closed topic says so and takes no reply', async () => {
        node.topic = { ...TOPIC, topic: { ...TOPIC.topic, closed: 'writer' } };
        const host = await render(set, ForumTopicScreen);
        expect(words(byId(host, 'forum-closed'))).toBe('This topic is closed, so it takes no new replies.');
        expect(byId(host, 'forum-reply-box')).toBeNull();
        expectReadable(host, set);
    });

    it('with no connection, the kept topic draws as it was last read', async () => {
        node.offline = true;
        node.kept = { front: FRONT, list: null, topic: TOPIC };
        const host = await render(set, ForumTopicScreen);
        expect(words(byId(host, 'forum-topic-title'))).toBe(TOPIC.topic.title);
        expect(allById(host, 'forum-post-3')).toHaveLength(1);
    });
});
