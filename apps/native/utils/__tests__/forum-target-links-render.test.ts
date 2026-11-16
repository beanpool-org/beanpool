// @vitest-environment jsdom
/**
 * What a forum topic links, on the phone (slice F9 part 3; components/forum/ForumLinks.tsx, app/forum/[id].tsx, utils/forum-need.ts),
 * rendered for real in each of the phone's three looks (Classic is the code's `dark`, Light is `light`, Dark is `night`) at the
 * floor's window (320 x 569 dp, text at 1.3x), with the harness of forum-render.test.ts: react-dom in jsdom, React Native's host
 * components as plain tags carrying their styles. The node's answers are fixtures in #3237's shapes (@beanpool/core ForumLink).
 *
 * - **The link-kind table** (the web's table, the same rows): every kind (a group, an Offer, a Need its topic's writer made, a
 *   Need by someone else, an event, a Learn page) shown, and every kind as a placeholder -> the chip's words, where a tap opens,
 *   and for a placeholder nothing to tap and nothing but its kind.
 * - **The invariant:** a link never shows its reader anything they could not already see. The phone draws exactly the node's
 *   answer: a kept copy's title is gone once the node answers a placeholder, and a thing picked in the Link picker is drawn only
 *   as the node's read of the topic says (a placeholder stays a placeholder, its picked title nowhere on screen).
 * - **The Link picker** (the writer's ⋯ only): what to link, the member's own of that kind, one already linked marked and taken
 *   off by a tap; the node's refusal (three a topic) said in its words.
 * - **Make this a Need** (flow): the writer's ⋯ opens the Need form with the topic, its title and words cut to the form's
 *   limits handed over once; the Need posted is linked to the topic; back on the topic it reads itself again and shows
 *   "Posted as a Need ›"; a refusal of the link leaves the Need standing with the node's sentence.
 * - **The topics that link one thing:** "Talked about in the forum" on a listing, "Topics about this group" in a group's sheet,
 *   "From the forum" on a Learn page; a tap opens the topic (a sheet closes first); nothing at all with none or with no answer.
 * - **Every look, 320 dp, 1.3x:** every word in readable ink on its own ground (4.5:1), every button 48 dp tall, nothing fixed-width.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, useImperativeHandle, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BRAND_SETS, contrastRatio, type ForumLink } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, numberOfLines, style, disabled, value, onChangeText, visible } = props;
        if (visible === false) return null;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress(); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(!!accessibilityState.selected);
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (onChangeText) { attrs.value = value ?? ''; attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); }
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
// useFocusEffect as the stack runs it: once as the screen shows, and again each time it shows again (`refocus`).
const nav = vi.hoisted(() => ({ pushed: [] as unknown[], params: { id: 't1' } as Record<string, string>, focus: new Set<() => void>() }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => { nav.pushed.push(to); }, back: () => {}, replace: (to: unknown) => { nav.pushed.push(to); }, canGoBack: () => true },
    useLocalSearchParams: () => nav.params,
    useFocusEffect: (effect: () => void) => { useEffect(() => { nav.focus.add(effect); effect(); return () => { nav.focus.delete(effect); }; }, [effect]); },
}));
const look = vi.hoisted(() => ({ colors: null as any, theme: 'dark' as string }));
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ theme: look.theme, colors: look.colors }),
    useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: look.theme, colors: look.colors, patternEnabled: false }),
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: import('react').ReactNode }) => createElement('div', null, children) }));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children, testID }: { children?: import('react').ReactNode; testID?: string }) => createElement('div', { 'data-testid': testID }, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('../keyboard-alert', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('../blocklist', () => ({ blockUser: vi.fn(async () => true) }));
vi.mock('../identity', () => ({ loadIdentity: async () => ({ publicKey: ME }) }));
vi.mock('../../components/chat/styles', () => ({ makeChatStyles: () => ({}) }));
vi.mock('../../components/chat/ChatComposer', async () => {
    const { forwardRef } = await import('react');
    return {
        ChatComposer: forwardRef((_props: Record<string, unknown>, ref) => {
            const [text, setText] = useState('');
            useImperativeHandle(ref, () => ({ setText, reset: () => setText(''), focus: () => {}, currentText: () => text }), [text]);
            return createElement('div', { 'data-testid': 'forum-composer' });
        }),
    };
});
vi.mock('expo-image-picker', () => ({}));
vi.mock('../chat-photo', () => ({ chatPhotoDataUri: vi.fn(), withinMs: (p: Promise<unknown>) => p }));
vi.mock('../post-photo', () => ({ askPhotoSource: vi.fn() }));
vi.mock('../../components/ReportMessageSheet', () => ({ ReportMessageSheet: () => null }));
// The member's own things the picker lists (utils/db): their groups (and other chats, which it leaves out), their listings
// (and ones done or taken down, which it leaves out), the events they are going to.
const mine = vi.hoisted(() => ({ failed: false }));
vi.mock('../db', () => ({
    fetchYourGroups: vi.fn(async () => {
        if (mine.failed) throw new Error('offline');
        return { items: [{ kind: 'group', id: 'g1', name: 'Garden crew' }, { kind: 'group', id: 'g2', name: 'Seed swap' }, { kind: 'enterprise', id: 'e1', name: 'Bakery' }], totalUnread: 0 };
    }),
    getMyPosts: vi.fn(async () => [
        { id: 'l1', title: 'Spare ladder', type: 'offer', status: 'active' },
        { id: 'l2', title: 'Old offer', type: 'offer', status: 'removed' },
        { id: 'l3', title: 'A poll of mine', type: 'poll', status: 'active' },
    ]),
    fetchMyEvents: vi.fn(async () => [{ postId: 'ev1', title: 'Working bee', startAt: '2026-12-01T10:00:00Z' }]),
}));

const ME = 'm'.repeat(64);
const ANA = 'a'.repeat(64);
const node = vi.hoisted(() => ({ front: null as any, topic: null as any, kept: null as any, linked: [] as unknown[], linkedFails: false, linkRefusal: null as string | null }));
vi.mock('../forum', () => ({
    getForumFront: vi.fn(async () => node.front),
    getForumTopic: vi.fn(async () => node.topic),
    keptForumFront: vi.fn(async () => null),
    keptForumTopic: vi.fn(async () => node.kept),
    keptForumDraft: vi.fn(async () => null),
    keepForumDraft: vi.fn(async () => {}),
    readForumTopic: vi.fn(async () => 1),
    forumPhotoUri: vi.fn(async () => null),
    forgetForumTopic: vi.fn(async () => {}),
    noteForumBack: vi.fn(),
    followForumTopic: vi.fn(), closeForumTopic: vi.fn(), removeForumPost: vi.fn(), replyInForum: vi.fn(), reportForumPost: vi.fn(), markForumTold: vi.fn(),
    linkForumTarget: vi.fn(async () => {
        if (node.linkRefusal) throw Object.assign(new Error(node.linkRefusal), { status: 409, code: 'topic_links' });
        return { topic: node.topic.topic };
    }),
    forumTopicsLinking: vi.fn(async () => {
        if (node.linkedFails) throw Object.assign(new Error(''), { unsaid: true });
        return node.linked;
    }),
}));

import ForumTopicScreen from '../../app/forum/[id]';
import { ForumLinkedTopics, forumLinkHref } from '../../components/forum/ForumLinks';
import { cutTo, linkPostedNeed, needSeedFrom, noteNeedLinked, takeNeedLinked, takeNeedSeed, NEED_TITLE_MAX } from '../forum-need';
import { COLOUR_SETS } from '../../constants/colors';
import { takeForumAt } from '../forum-open';
import * as forum from '../forum';

const LOOKS = [['Classic', 'dark'], ['Light', 'light'], ['Dark', 'night']] as const;
type Set = (typeof BRAND_SETS)[number];

const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const FRONT = {
    sections: [{ id: 'skills', starter: 'skills', name: null, about: null, position: 1, starts: 'members', listed: true, archived: false }],
    public: false, told: true, moderator: false, firstLooksWaiting: null, firstTopicWaits: false, linksOn: true,
};
const writer = (publicKey: string, name: string) => ({ publicKey, name });
const topicOf = (over: Record<string, unknown> = {}) => ({
    id: 't1', sectionId: 'skills', title: 'Who can lend a ladder for the hall roof this weekend?', writer: writer(ME, 'Marty'), place: null, lang: 'en',
    replyCount: 1, lastActivityAt: at(3), createdAt: at(30), pinned: false, closed: null, removed: false, hidden: false, follow: null, unread: false, ...over,
});
const OPENING = 'We need a long ladder for the hall roof. Two of us can do the work on Saturday morning if someone can lend one.';
const pageOf = (links: ForumLink[] | undefined, over: Record<string, unknown> = {}) => ({
    topic: topicOf({ ...over, ...(links ? { links } : {}) }),
    posts: [
        { id: 'p1', topicId: 't1', number: 1, writer: (over.writer as any) ?? writer(ME, 'Marty'), words: OPENING, quotes: null, lang: 'en', createdAt: at(30), editedAt: null, removed: null, photos: 0, hidden: false, linksOn: true },
        { id: 'p2', topicId: 't1', number: 2, writer: writer(ANA, 'Asha'), words: 'I have one, a 6 m one.', quotes: null, lang: 'en', createdAt: at(3), editedAt: null, removed: null, photos: 0, hidden: false, linksOn: true },
    ],
    next: null, lastRead: 2,
});
const shown = (kind: ForumLink['kind'], id: string, title: string, over: Partial<Extract<ForumLink, { shown: true }>> = {}): ForumLink =>
    ({ kind, shown: true, id, title, photo: null, listingType: null, startAt: null, byWriter: false, ...over });
const hidden = (kind: ForumLink['kind']): ForumLink => ({ kind, shown: false });

/**
 * The link-kind table: the web's rows (one per kind of thing a topic links, shown, then each as a placeholder) -> what the chip
 * says, where a tap opens. A placeholder opens nothing and says its kind alone.
 */
const TABLE: { name: string; link: ForumLink; words: string; opens: unknown }[] = [
    { name: 'a group', link: shown('group', 'g1', 'Garden crew', { byWriter: true }), words: 'A group › Garden crew', opens: { pathname: '/group/[id]', params: { id: 'g1' } } },
    { name: 'an Offer', link: shown('listing', 'l1', 'Spare ladder', { listingType: 'offer' }), words: 'An Offer › Spare ladder', opens: { pathname: '/post/[id]', params: { id: 'l1' } } },
    { name: 'a Need its writer made', link: shown('listing', 'n1', 'A long ladder', { listingType: 'need', byWriter: true }), words: 'Posted as a Need › A long ladder', opens: { pathname: '/post/[id]', params: { id: 'n1' } } },
    { name: 'a Need by someone else', link: shown('listing', 'n2', 'Roof tiles', { listingType: 'need' }), words: 'A Need › Roof tiles', opens: { pathname: '/post/[id]', params: { id: 'n2' } } },
    { name: 'an event', link: shown('event', 'ev1', 'Working bee', { startAt: '2026-12-01T10:00:00Z' }), words: 'An event › Working bee', opens: { pathname: '/post/[id]', params: { id: 'ev1' } } },
    { name: 'a Learn page', link: shown('learn', 'k1', 'Fixing a roof safely'), words: 'A Learn page › Fixing a roof safely', opens: { pathname: '/post/[id]', params: { id: 'k1', kind: 'knowledge' } } },
    { name: 'a group it can\'t see', link: hidden('group'), words: 'Linked: a group', opens: null },
    { name: 'a listing it can\'t see', link: hidden('listing'), words: 'Linked: a listing', opens: null },
    { name: 'an event it can\'t see', link: hidden('event'), words: 'Linked: an event', opens: null },
    { name: 'a Learn page it can\'t see', link: hidden('learn'), words: 'Linked: a Learn page', opens: null },
];

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
const styleOf = (n: Element) => JSON.parse(n.getAttribute('data-style') ?? '{}');
const words = (n: Element | null) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** A chip's lines (its kind, its title), one space between. */
const chipWords = (n: Element | null) => Array.from(n?.querySelectorAll('span') ?? []).map(words).join(' ');
const buttonsIn = (host: ParentNode) => Array.from(host.querySelectorAll('[data-role="button"]')) as HTMLElement[];
const press = async (n: Element) => { await act(async () => { (n as HTMLElement).click(); }); await act(async () => {}); await act(async () => {}); };
const menuButton = (host: ParentNode, label: string) => Array.from(byId(host, 'forum-menu').querySelectorAll('button')).find((b) => words(b) === label);
const refocus = async () => { await act(async () => { for (const f of nav.focus) f(); }); await act(async () => {}); await act(async () => {}); };

/** Every text drawn: its ink against the nearest ground under it (the page where nothing nearer is drawn), at 4.5:1 or more. */
function expectReadable(host: HTMLElement, set: Set, least = 3) {
    const c = COLOUR_SETS[set];
    let n = 0;
    for (const span of Array.from(host.querySelectorAll('span'))) {
        if (!words(span) || span.querySelector('span')) continue;
        let ink: string | undefined;
        let ground: string | undefined;
        for (let el: Element | null = span; el && el !== host; el = el.parentElement) {
            const s = styleOf(el);
            if (!ink && s.color) ink = s.color;
            if (!ground && s.backgroundColor) ground = s.backgroundColor;
        }
        expect(ink, words(span)).toBeTruthy();
        const on = ground ?? c.surface.page;
        expect(contrastRatio(ink!, on), `${words(span)} (${ink} on ${on})`).toBeGreaterThanOrEqual(4.5);
        n += 1;
    }
    expect(n).toBeGreaterThanOrEqual(least);
}
/** At 320 dp and 1.3x: no width fixed on anything with words in it, no line count, every button at least 40 dp (48 for words). */
function expectHoldsSmall(host: HTMLElement) {
    for (const el of Array.from(host.querySelectorAll('span, button, div'))) {
        const s = styleOf(el);
        if (typeof s.width === 'number' && words(el)) throw new Error(`fixed width on "${words(el).slice(0, 40)}"`);
    }
    expect(host.querySelector('[data-lines]')).toBeNull();
    for (const b of buttonsIn(host)) {
        const s = styleOf(b);
        expect(Math.max(s.minHeight ?? 0, s.height ?? 0), `${b.getAttribute('aria-label') ?? words(b)}`).toBeGreaterThanOrEqual(words(b) ? 48 : 40);
    }
}

beforeEach(() => {
    document.body.innerHTML = '';
    nav.pushed = [];
    nav.params = { id: 't1' };
    nav.focus.clear();
    mine.failed = false;
    Object.assign(node, { front: FRONT, topic: pageOf(undefined), kept: null, linked: [], linkedFails: false, linkRefusal: null });
    takeNeedSeed('t1');
    takeNeedLinked('t1');
    vi.clearAllMocks();
});

describe.each(LOOKS)('the link-kind table in %s (%s)', (_name, set) => {
    it('every kind shown and every kind as a placeholder: the chip\'s words, where a tap opens, and nothing to tap on a placeholder', async () => {
        node.topic = pageOf(TABLE.map((r) => r.link));
        const host = await render(set, ForumTopicScreen);
        const chips = Array.from(byId(host, 'forum-link-chips').children) as HTMLElement[];
        expect(chips.map(chipWords)).toEqual(TABLE.map((r) => r.words));
        for (const [i, row] of TABLE.entries()) {
            const chip = chips[i];
            if (row.opens) {
                expect(chip.getAttribute('data-role'), row.name).toBe('button');
                expect(forumLinkHref(row.link as Extract<ForumLink, { shown: true }>), row.name).toEqual(row.opens);
                nav.pushed = [];
                await press(chip);
                expect(nav.pushed, row.name).toEqual([row.opens]);
            } else {
                // A placeholder: no button, nothing pressable inside, its kind's words alone.
                expect(chip.getAttribute('data-role'), row.name).toBeNull();
                expect(chip.querySelector('button'), row.name).toBeNull();
                expect(chip.getAttribute('data-testid')).toBe(`forum-link-hidden-${row.link.kind}`);
            }
        }
        expectReadable(byId(host, 'forum-link-chips'), set);
        expectHoldsSmall(byId(host, 'forum-link-chips'));
    });

    it('the writer\'s ⋯ holds Link and Make this a Need; another member\'s holds neither', async () => {
        const host = await render(set, ForumTopicScreen);
        await press(byId(host, 'forum-topic-menu'));
        expect(menuButton(host, 'Link a group, listing or event')).toBeTruthy();
        expect(menuButton(host, 'Make this a Need')).toBeTruthy();
        expectReadable(byId(host, 'forum-menu'), set);
        document.body.innerHTML = '';
        node.topic = pageOf(undefined, { writer: writer(ANA, 'Asha') });
        const other = await render(set, ForumTopicScreen);
        await press(byId(other, 'forum-topic-menu'));
        expect(menuButton(other, 'Link a group, listing or event')).toBeUndefined();
        expect(menuButton(other, 'Make this a Need')).toBeUndefined();
    });

    it('the Link picker: what to link, then the member\'s own groups (not their other chats), one linked marked, a tap links it, the topic read again', async () => {
        node.topic = pageOf([shown('group', 'g1', 'Garden crew', { byWriter: true })]);
        const host = await render(set, ForumTopicScreen);
        await press(byId(host, 'forum-topic-menu'));
        await press(menuButton(host, 'Link a group, listing or event')!);
        const picker = () => byId(host, 'forum-link-picker');
        expect(buttonsIn(picker()).map(words)).toEqual(['One of your groups', 'One of your listings', 'An event', 'Cancel']);
        expectReadable(picker(), set);
        expectHoldsSmall(picker());
        await press(byId(host, 'forum-link-kind-group'));
        expect(buttonsIn(picker()).map(words)).toEqual(['✓ Garden crew', 'Seed swap', 'Back', 'Cancel']);
        expect(byId(host, 'forum-link-pick-g1').getAttribute('aria-label')).toBe('Garden crew: linked. Tap to take it off.');
        const reads = vi.mocked(forum.getForumTopic).mock.calls.length;
        await press(byId(host, 'forum-link-pick-g2'));
        expect(forum.linkForumTarget).toHaveBeenCalledWith('t1', 'group', 'g2', true);
        expect(vi.mocked(forum.getForumTopic).mock.calls.length).toBeGreaterThan(reads);
        expect(picker()).toBeNull();
        // A tap on the one linked takes it off.
        await press(byId(host, 'forum-topic-menu'));
        await press(menuButton(host, 'Link a group, listing or event')!);
        await press(byId(host, 'forum-link-kind-group'));
        await press(byId(host, 'forum-link-pick-g1'));
        expect(forum.linkForumTarget).toHaveBeenLastCalledWith('t1', 'group', 'g1', false);
    });

    it('the picker lists only open Offers and Needs of the member\'s and the events they go to; nothing to read says so', async () => {
        const host = await render(set, ForumTopicScreen);
        await press(byId(host, 'forum-topic-menu'));
        await press(menuButton(host, 'Link a group, listing or event')!);
        await press(byId(host, 'forum-link-kind-listing'));
        expect(buttonsIn(byId(host, 'forum-link-picker')).map(words)).toEqual(['Spare ladder', 'Back', 'Cancel']);
        await press(byId(host, 'forum-link-back'));
        await press(byId(host, 'forum-link-kind-event'));
        expect(buttonsIn(byId(host, 'forum-link-picker')).map(words)).toEqual(['Working bee', 'Back', 'Cancel']);
        await press(byId(host, 'forum-link-back'));
        mine.failed = true;
        await press(byId(host, 'forum-link-kind-group'));
        expect(words(byId(host, 'forum-link-picker'))).toContain('Couldn’t load these. Check your connection and try again.');
    });
});

describe('a link never shows its reader anything they could not already see', () => {
    it('a kept copy\'s title is gone once the node answers a placeholder for it', async () => {
        node.kept = pageOf([shown('group', 'g9', 'Secret garden club')]);
        node.topic = pageOf([hidden('group')]);
        const host = await render('light', ForumTopicScreen);
        expect(host.innerHTML).not.toContain('Secret garden club');
        expect(host.innerHTML).not.toContain('g9');
        expect(words(byId(host, 'forum-link-chips'))).toBe('Linked: a group');
    });

    it('a thing picked is drawn only as the node\'s read of the topic says: a placeholder stays one, its picked title nowhere', async () => {
        const host = await render('light', ForumTopicScreen);
        // The node takes the link but reads it back to this member as a placeholder (say, the group closed meanwhile).
        node.topic = pageOf([hidden('group')]);
        await press(byId(host, 'forum-topic-menu'));
        await press(menuButton(host, 'Link a group, listing or event')!);
        await press(byId(host, 'forum-link-kind-group'));
        await press(byId(host, 'forum-link-pick-g2'));
        expect(byId(host, 'forum-link-picker')).toBeNull();
        expect(words(byId(host, 'forum-link-chips'))).toBe('Linked: a group');
        expect(host.innerHTML).not.toContain('Seed swap');
    });

    it('the node\'s refusal (three links a topic) is said in its own words, and no chip is drawn for the pick', async () => {
        node.linkRefusal = 'A topic links at most three things. Take one off first.';
        const host = await render('light', ForumTopicScreen);
        await press(byId(host, 'forum-topic-menu'));
        await press(menuButton(host, 'Link a group, listing or event')!);
        await press(byId(host, 'forum-link-kind-group'));
        await press(byId(host, 'forum-link-pick-g2'));
        expect(words(byId(host, 'forum-reply-error'))).toBe(node.linkRefusal);
        expect(byId(host, 'forum-link-chips')).toBeNull();
    });
});

describe('Make this a Need (flow)', () => {
    it('the writer\'s ⋯ opens the Need form for this topic, its title and words handed over once; posted, the Need is linked and the topic shows "Posted as a Need ›"', async () => {
        const host = await render('light', ForumTopicScreen);
        await press(byId(host, 'forum-topic-menu'));
        await press(menuButton(host, 'Make this a Need')!);
        expect(nav.pushed).toEqual([{ pathname: '/new-listing', params: { newPost: 'need', fromTopic: 't1' } }]);
        // The form (app/new-listing.tsx) takes the topic's title, cut to its field's 50, and the opening words; once.
        expect(takeNeedSeed('another-topic')).toBeNull();
        const seed = takeNeedSeed('t1');
        expect(seed).toEqual({ topicId: 't1', title: cutTo(topicOf().title, NEED_TITLE_MAX), words: OPENING });
        expect(seed!.title.length).toBeLessThanOrEqual(NEED_TITLE_MAX);
        expect(takeNeedSeed('t1')).toBeNull();
        // Posted: linked to the topic as the member's listing, and the topic told to read itself again.
        expect(await linkPostedNeed('t1', 'n1')).toBeNull();
        expect(forum.linkForumTarget).toHaveBeenCalledWith('t1', 'listing', 'n1');
        noteNeedLinked('t1');
        node.topic = pageOf([shown('listing', 'n1', 'Who can lend a ladder for the hall roof this', { listingType: 'need', byWriter: true })]);
        await refocus();
        const chip = byId(host, 'forum-link-listing');
        expect(chipWords(chip)).toBe('Posted as a Need › Who can lend a ladder for the hall roof this');
        await press(chip);
        expect(nav.pushed.at(-1)).toEqual({ pathname: '/post/[id]', params: { id: 'n1' } });
        // Shown again for any other reason, the topic doesn't read itself for this.
        const reads = vi.mocked(forum.getForumTopic).mock.calls.length;
        await refocus();
        expect(vi.mocked(forum.getForumTopic).mock.calls.length).toBe(reads);
    });

    it('a refusal of the link leaves the Need standing, with the node\'s sentence for the form to say', async () => {
        node.topic = pageOf(undefined);
        node.linkRefusal = 'A topic links at most three things. Take one off first.';
        expect(await linkPostedNeed('t1', 'n1')).toBe(node.linkRefusal);
    });

    it('the title and words are cut to the form\'s limits, never through a character', () => {
        const long = `${'a'.repeat(49)}🙂 and more`;
        expect(cutTo(long, 50)).toBe('a'.repeat(49));
        expect(cutTo('🙂🙂🙂', 4)).toBe('🙂🙂');
        const seed = needSeedFrom('t1', `  ${'Ladder '.repeat(20)}  `, 'w'.repeat(6000));
        expect(seed.title.length).toBeLessThanOrEqual(50);
        expect(seed.words.length).toBe(5000);
    });
});

describe.each(LOOKS)('the topics that link one thing in %s (%s)', (_name, set) => {
    const LINKED = [
        { id: 't1', sectionId: 'skills', title: 'Who can lend a ladder for the hall roof this weekend?', replyCount: 3, lastActivityAt: at(2) },
        { id: 't7', sectionId: 'skills', title: 'Roof jobs this summer', replyCount: 1, lastActivityAt: at(20) },
    ];
    it.each([
        ['listing', 'Talked about in the forum'],
        ['group', 'Topics about this group'],
        ['learn', 'From the forum'],
    ] as const)('on a %s: "%s" and each topic, a tap anywhere on a row opens it', async (kind, heading) => {
        node.linked = LINKED;
        const onLeave = vi.fn();
        const host = await render(set, () => createElement(ForumLinkedTopics, { kind, id: 'x1', onLeave }));
        expect(forum.forumTopicsLinking).toHaveBeenCalledWith(kind, 'x1');
        const box = byId(host, `forum-linked-${kind}`);
        expect(words(box.querySelector('[data-role="header"]'))).toBe(heading);
        const rows = Array.from(box.querySelectorAll('[data-testid="forum-linked-topic"]'));
        expect(rows.map(words)).toEqual([`${LINKED[0].title}3 replies›`, `${LINKED[1].title}1 reply›`]);
        await press(rows[1]);
        expect(onLeave).toHaveBeenCalled();
        expect(nav.pushed).toEqual([{ pathname: '/forum/[id]', params: { id: 't7' } }]);
        expectReadable(box, set);
        expectHoldsSmall(box);
    });

    it('a group with its own section: "Topics ›" opens the Forum on that section (the sheet closes first), with no linking topic needed', async () => {
        node.front = { ...FRONT, sections: [...FRONT.sections, { id: 'sec-g1', starter: null, name: 'Garden crew', about: null, position: 2, starts: 'members', listed: true, archived: false, group: { id: 'g1', name: 'Garden crew' } }] };
        node.linked = [];
        const onLeave = vi.fn();
        const host = await render(set, () => createElement(ForumLinkedTopics, { kind: 'group', id: 'g1', onLeave }));
        const row = byId(host, 'forum-group-section');
        expect(words(row)).toBe('Topics ›');
        expect(host.querySelector('[data-role="header"]')).toBeNull();
        await press(row);
        expect(onLeave).toHaveBeenCalled();
        expect(nav.pushed).toEqual([{ pathname: '/(tabs)/chats', params: { view: 'forum' } }]);
        expect(takeForumAt()).toBe('sec-g1');
        expectReadable(byId(host, 'forum-linked-group'), set, 1);
        expectHoldsSmall(byId(host, 'forum-linked-group'));
        // Another group, or a listing, has no such row.
        document.body.innerHTML = '';
        const other = await render(set, () => createElement(ForumLinkedTopics, { kind: 'group', id: 'g2' }));
        expect(byId(other, 'forum-group-section')).toBeNull();
    });

    it('nothing at all with no topics, or with no answer (a community with no forum, a node from before F9, no connection)', async () => {
        node.linked = [];
        let host = await render(set, () => createElement(ForumLinkedTopics, { kind: 'listing', id: 'x1' }));
        expect(forum.forumTopicsLinking).toHaveBeenCalledWith('listing', 'x1');
        expect(host.innerHTML).toBe('');
        node.linkedFails = true;
        node.linked = LINKED;
        host = await render(set, () => createElement(ForumLinkedTopics, { kind: 'group', id: 'x1' }));
        expect(host.innerHTML).toBe('');
    });
});
