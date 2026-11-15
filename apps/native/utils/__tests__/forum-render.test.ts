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
 * - **Part 2:** the search box under ＋ New topic (its hits take the topic list's place); the reply box's photo button where the
 *   forum takes the member's photos, the photos waiting with ✕; a draft put back in the box, kept when a send fails and when the
 *   member leaves with words in the box; New topic's photo row.
 * - **Every look, 320 dp, 1.3x:** every word in readable ink on its own ground (4.5:1), every button 48 dp tall, nothing
 *   fixed-width and no title cut to a line count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, useImperativeHandle, useState } from 'react';
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
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), Modal: el('div'), Image: el('img'), TextInput: el('input'), ActivityIndicator: el('i'),
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
// The chat's composer, as far as the forum uses it: its handle (setText, currentText), the photo button where onAttach is
// given, the waiting photos above the box, and Send (asking canSend first, emptying the box, then onSend), as the real one does.
vi.mock('../../components/chat/ChatComposer', async () => {
    const { forwardRef } = await import('react');
    type P = { placeholder: string; onSend: (w: string) => unknown; canSend?: () => boolean; onAttach?: () => void; attachment?: unknown };
    return {
        ChatComposer: forwardRef((props: P, ref) => {
            const [text, setText] = useState('');
            useImperativeHandle(ref, () => ({ setText: (w: string) => { composerCalls.push(`setText:${w}`); setText(w); }, reset: () => setText(''), focus: () => {}, currentText: () => text.trim() }), [text]);
            return createElement('div', { 'data-testid': 'forum-composer' },
                props.attachment as any,
                props.onAttach ? createElement('button', { 'data-testid': 'forum-composer-attach', onClick: props.onAttach }) : null,
                createElement('textarea', { 'data-testid': 'forum-reply-box', placeholder: props.placeholder, value: text, onChange: (e: { target: { value: string } }) => setText(e.target.value) }),
                createElement('button', { 'data-testid': 'forum-composer-send', onClick: async () => { if (props.canSend && !props.canSend()) return; const w = text; setText(''); await props.onSend(w); } }));
        }),
    };
});
const composerCalls = vi.hoisted(() => [] as string[]);
const picker = vi.hoisted(() => ({ next: null as string | null, asked: 0 }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('../chat-photo', () => ({ chatPhotoDataUri: vi.fn(), withinMs: (p: Promise<unknown>) => p }));
vi.mock('../post-photo', () => ({ askPhotoSource: vi.fn() }));
vi.mock('../../components/forum/ForumBits', async (orig) => ({
    ...(await orig<object>()),
    pickForumPhoto: vi.fn(async () => { picker.asked += 1; return picker.next; }),
}));
vi.mock('../forum-search', () => ({ searchForum: vi.fn(async () => node.search) }));
const worldwide = vi.hoisted(() => ({ joined: false, opened: [] as string[], answer: 'switched' as string }));
vi.mock('../worldwide-forum', () => ({
    worldwideForumJoined: vi.fn(async () => worldwide.joined),
    openWorldwideForum: vi.fn(async (me: string) => { worldwide.opened.push(me); return worldwide.answer; }),
}));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'member' }) }));
vi.mock('../../components/ReportMessageSheet', () => ({ ReportMessageSheet: () => null }));

const ME = 'm'.repeat(64);
const ANA = 'a'.repeat(64);
// No connection: what utils/forum.ts throws with no answer (forumRefusal), no words of its own, so the screen says its line. `refused`:
// the node's sentence, as forumRefusal hands it on.
const node = vi.hoisted(() => ({ offline: false, refused: null as string | null, front: null as any, list: null as any, topic: null as any, kept: { front: null as any, list: null as any, topic: null as any }, mine: null as any, search: null as any, draft: null as any, replyFails: false }));
const unanswered = () => {
    if (node.refused) throw Object.assign(new Error(node.refused), { status: 403, code: 'not_active' });
    if (node.offline) throw Object.assign(new Error(''), { unsaid: true });
};
vi.mock('../forum', () => ({
    FIRST_LOOK_NO_REASONS: ['spam', 'offensive', 'misleading', 'unsafe', 'rules'],
    getForumFront: vi.fn(async () => { unanswered(); return node.front; }),
    getForumTopics: vi.fn(async () => { unanswered(); return node.list; }),
    getForumTopic: vi.fn(async () => { unanswered(); return node.topic; }),
    keptForumFront: vi.fn(async () => node.kept.front),
    keptForumList: vi.fn(async () => node.kept.list),
    keptForumTopic: vi.fn(async () => node.kept.topic),
    myFirstLook: vi.fn(async () => node.mine ?? { waiting: null, usuallyWithinHours: null }),
    takeForumBack: () => null,
    noteForumBack: vi.fn(),
    readForumTopic: vi.fn(async () => 9),
    forumPhotoUri: vi.fn(async () => null),
    forgetForumTopic: vi.fn(async () => {}),
    withdrawFirstLook: vi.fn(async () => {}), followForumTopic: vi.fn(), closeForumTopic: vi.fn(), removeForumPost: vi.fn(),
    replyInForum: vi.fn(async () => { if (node.replyFails) throw Object.assign(new Error(''), { unsaid: true }); return { number: 5 }; }),
    reportForumPost: vi.fn(), markForumTold: vi.fn(), startForumTopic: vi.fn(async () => ({ topic: { id: 't9' }, post: {} })),
    keptForumDraft: vi.fn(async () => node.draft),
    keepForumDraft: vi.fn(async () => {}),
}));

import { ForumPane } from '../../components/forum/ForumPane';
import ForumTopicScreen from '../../app/forum/[id]';
import NewForumTopicScreen from '../../app/forum/new';
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

let lastRoot: Root | null = null;
async function render(set: Set, what: () => unknown): Promise<HTMLElement> {
    look.colors = COLOUR_SETS[set];
    look.theme = set;
    const host = document.createElement('div');
    document.body.appendChild(host);
    lastRoot = createRoot(host);
    await act(async () => { lastRoot!.render(createElement(what as any) as unknown as Parameters<Root['render']>[0]); });
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
    Object.assign(node, { offline: false, refused: null, front: FRONT, list: LIST, topic: TOPIC, kept: { front: null, list: null, topic: null }, mine: null, search: null, draft: null, replyFails: false });
    picker.next = null;
    picker.asked = 0;
    composerCalls.length = 0;
    Object.assign(worldwide, { joined: false, opened: [], answer: 'switched' });
    vi.clearAllMocks();
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

    it('with no connection, the kept list draws, with the forum\'s own line and Try again (never the platform\'s English)', async () => {
        node.offline = true;
        node.kept = { front: FRONT, list: LIST, topic: null };
        const host = await render(set, ForumPane);
        expect(allById(host, 'forum-topic-row')).toHaveLength(3);
        expect(words(host)).toContain('Couldn’t load the forum. Check your connection and try again.');
        expect(buttonsIn(host).map(words)).toContain('Try again');
        expectReadable(host, set);
    });

    it('a refusal from the node: the kept list draws, with the node\'s sentence and Try again', async () => {
        node.refused = 'Your account here is paused for now, so you can’t read or write in the forum.';
        node.kept = { front: FRONT, list: LIST, topic: null };
        const host = await render(set, ForumPane);
        expect(allById(host, 'forum-topic-row')).toHaveLength(3);
        expect(words(host)).toContain(node.refused);
        expect(words(host)).not.toContain('Couldn’t load the forum.');
        expect(buttonsIn(host).map(words)).toContain('Try again');
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

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQ';
const typeIn = async (box: Element, value: string) => {
    await act(async () => {
        const proto = box instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(box, value);
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

describe.each(LOOKS)('the forum list\'s search in %s (%s)', (_name, set) => {
    it('draws the search box under ＋ New topic, as the web; hits take the topic list\'s place and open the topic at the post found', async () => {
        node.search = { hits: [{ topicId: 't2', sectionId: 'skills', title: 'Seed swap ideas', postId: 'p7', number: 7, writer: writer(ANA, 'Asha'), createdAt: at(2), excerpt: '…swap seeds in spring…' }], next: null };
        const host = await render(set, ForumPane);
        const order = Array.from(host.querySelectorAll('[data-testid]')).map((n) => n.getAttribute('data-testid')).filter((id) => ['forum-new', 'forum-search', 'forum-topics'].includes(id!));
        expect(order).toEqual(['forum-new', 'forum-search', 'forum-topics']);
        expect(byId(host, 'forum-search-box').getAttribute('aria-label')).toBe('Search the forum');
        await typeIn(byId(host, 'forum-search-box'), 'swap seeds');
        await press(byId(host, 'forum-search-go'));
        expect(allById(host, 'forum-topic-row')).toHaveLength(0);
        const hit = byId(host, 'forum-search-hit');
        expect(words(hit)).toContain('Seed swap ideas');
        expect(words(hit)).toContain('Asha · Skills & how-to');
        await press(hit);
        expect(nav.pushed).toEqual([{ pathname: '/forum/[id]', params: { id: 't2', at: '7' } }]);
        expectReadable(host, set);
        expectHoldsSmall(host);
        // ✕ gives the list back.
        await press(byId(host, 'forum-search-clear'));
        expect(allById(host, 'forum-topic-row')).toHaveLength(3);
    });
});

describe.each(LOOKS)('a topic\'s photos and draft in %s (%s)', (_name, set) => {
    it('the reply box has the photo button where the forum takes the member\'s photos; a picked photo waits with ✕ and goes with the reply', async () => {
        const host = await render(set, ForumTopicScreen);
        expect(byId(host, 'forum-composer-attach')).not.toBeNull();
        picker.next = PHOTO;
        await press(byId(host, 'forum-composer-attach'));
        expect(picker.asked).toBe(1);
        expect(byId(host, 'forum-attached').querySelector('img')!.getAttribute('data-src')).toBe(PHOTO);
        expect(byId(host, 'forum-attached-remove').getAttribute('aria-label')).toBe('Remove photo 1');
        // On the box's own band (the chat's staged-photo row), never on the page under the post above.
        expect(styleOf(byId(host, 'forum-attached')).backgroundColor).toBe(COLOUR_SETS[set].surface.card);
        expectHoldsSmall(host);
        // Photos alone don't send (a reply has words, as on the web); with words they go together.
        const { replyInForum, keepForumDraft } = await import('../forum');
        await press(byId(host, 'forum-composer-send'));
        expect(replyInForum).not.toHaveBeenCalled();
        await typeIn(byId(host, 'forum-reply-box'), 'Here is our seed table.');
        await press(byId(host, 'forum-composer-send'));
        expect(vi.mocked(replyInForum).mock.calls[0][1]).toMatchObject({ words: 'Here is our seed table.', photos: [PHOTO] });
        expect(byId(host, 'forum-attached')).toBeNull();
        expect(keepForumDraft).toHaveBeenLastCalledWith('t1', null);
        // Posted: the box is emptied through setText, which writes the native box (the composer's own clear can be dropped).
        expect(composerCalls.at(-1)).toBe('setText:');
    });

    it('a new writer (links and photos off) gets no photo button, as on the web', async () => {
        node.front = { ...FRONT, linksOn: false };
        const host = await render(set, ForumTopicScreen);
        expect(byId(host, 'forum-composer-attach')).toBeNull();
    });

    it('a kept draft is back in the box with its quote and photos; a send with no connection keeps it again', async () => {
        node.draft = { words: 'Typed on the bus', quotes: 2, photos: [PHOTO] };
        const host = await render(set, ForumTopicScreen);
        expect((byId(host, 'forum-reply-box') as HTMLTextAreaElement).value).toBe('Typed on the bus');
        expect(words(byId(host, 'forum-quote'))).toContain('Marty');
        expect(byId(host, 'forum-attached').querySelector('img')!.getAttribute('data-src')).toBe(PHOTO);
        node.replyFails = true;
        const { keepForumDraft } = await import('../forum');
        await press(byId(host, 'forum-composer-send'));
        expect(keepForumDraft).toHaveBeenLastCalledWith('t1', { words: 'Typed on the bus', quotes: 2, photos: [PHOTO] });
        // The words are back in the box, with the forum's own line (no answer has no words of its own).
        expect((byId(host, 'forum-reply-box') as HTMLTextAreaElement).value).toBe('Typed on the bus');
        // Just above the box, where the eye is (the box is pinned at the foot of a long topic).
        expect(words(byId(host, 'forum-reply-error'))).toBe('Couldn’t save this in the forum.');
        expect(byId(host, 'forum-reply').contains(byId(host, 'forum-reply-error'))).toBe(true);
        expectReadable(host, set);
    });

    it('a draft quoting a post that isn\'t drawn (gone since) is put back once, without the quote, and never again over new typing', async () => {
        node.draft = { words: 'About that post', quotes: 99, photos: [] };
        const host = await render(set, ForumTopicScreen);
        expect((byId(host, 'forum-reply-box') as HTMLTextAreaElement).value).toBe('About that post');
        expect(byId(host, 'forum-quote')).toBeNull();
        expect(composerCalls.filter((c) => c === 'setText:About that post')).toHaveLength(1);
        await typeIn(byId(host, 'forum-reply-box'), 'Something new');
        // A later read (here, a post's ⋯ action reads the topic again) never puts the draft back over it.
        const { followForumTopic } = await import('../forum');
        vi.mocked(followForumTopic).mockResolvedValueOnce('following');
        await press(byId(host, 'forum-follow'));
        expect((byId(host, 'forum-reply-box') as HTMLTextAreaElement).value).toBe('Something new');
        expect(composerCalls.filter((c) => c === 'setText:About that post')).toHaveLength(1);
        // And leaving keeps what is there now.
        const { keepForumDraft } = await import('../forum');
        await act(async () => { lastRoot!.unmount(); });
        expect(keepForumDraft).toHaveBeenLastCalledWith('t1', { words: 'Something new', quotes: null, photos: [] });
    });

    it('leaving the topic with words in the box keeps them as its draft', async () => {
        const host = await render(set, ForumTopicScreen);
        await typeIn(byId(host, 'forum-reply-box'), 'Half a thought');
        const { keepForumDraft } = await import('../forum');
        await act(async () => { lastRoot!.unmount(); });
        expect(keepForumDraft).toHaveBeenLastCalledWith('t1', { words: 'Half a thought', quotes: null, photos: [] });
    });
});

describe.each(LOOKS)('New topic\'s photos in %s (%s)', (_name, set) => {
    it('Add a photo where the member\'s photos are taken; the picked photo waits with ✕ and goes with the topic', async () => {
        const host = await render(set, NewForumTopicScreen);
        expect(words(byId(host, 'forum-attach'))).toBe('Add a photo');
        picker.next = PHOTO;
        await press(byId(host, 'forum-attach'));
        expect(byId(host, 'forum-attached').querySelector('img')!.getAttribute('data-src')).toBe(PHOTO);
        expectReadable(host, set);
        expectHoldsSmall(host);
    });

    it('a new member\'s first topic takes photos (a moderator sees them first); a writer whose links are off and who isn\'t new gets none', async () => {
        node.front = { ...FRONT, linksOn: false, firstTopicWaits: true };
        let host = await render(set, NewForumTopicScreen);
        expect(byId(host, 'forum-attach')).not.toBeNull();
        document.body.innerHTML = '';
        node.front = { ...FRONT, linksOn: false, firstTopicWaits: false };
        host = await render(set, NewForumTopicScreen);
        expect(byId(host, 'forum-attach')).toBeNull();
    });
});

describe.each(LOOKS)('the Worldwide forum row in %s (%s)', (_name, set) => {
    it('where the member has joined the worldwide community: "Worldwide forum ›" after the first-look row, before the topics; a tap moves there', async () => {
        worldwide.joined = true;
        node.front = { ...FRONT, moderator: true, firstLooksWaiting: 2 };
        const host = await render(set, ForumPane);
        const row = byId(host, 'forum-worldwide-row');
        expect(words(row)).toBe('Worldwide forum ›');
        const order = Array.from(host.querySelectorAll('[data-testid]')).map((n) => n.getAttribute('data-testid')).filter((id) => ['forum-first-looks-row', 'forum-worldwide-row', 'forum-topics'].includes(id!));
        expect(order).toEqual(['forum-first-looks-row', 'forum-worldwide-row', 'forum-topics']);
        await press(row);
        expect(worldwide.opened).toEqual([ME]);
        expectReadable(host, set);
        expectHoldsSmall(host);
    });

    it('no row where the member hasn\'t joined it (or is on it); a switch that didn\'t happen says so', async () => {
        let host = await render(set, ForumPane);
        expect(byId(host, 'forum-worldwide-row')).toBeNull();
        document.body.innerHTML = '';
        worldwide.joined = true;
        worldwide.answer = 'failed';
        host = await render(set, ForumPane);
        await press(byId(host, 'forum-worldwide-row'));
        expect(words(host)).toContain('Something went wrong. Try again in a moment.');
    });
});
