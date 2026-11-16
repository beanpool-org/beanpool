// @vitest-environment jsdom
/**
 * The asker's picker on Ask to join, on the phone (forums F11b; DESIGN-forums-fable.md §13, §14: 320 px, 1.3× text, light
 * and dark). The admins' side of the same posts is knock-forum-posts-render.test.ts; the web's twin of this file is
 * apps/pwa/src/components/KnockForumPicker.test.tsx.
 *
 * The real utils/forum-ask-picks.ts hook and reader, the real components/KnockForumPicker.tsx, and the real utils/knock.ts
 * knockBody, so each case ends in the body the request sends. The phone's storage, its guest list and the signed read are
 * stubbed at the boundary: the worldwide community answers GET /api/forum/ask-posts with Asha's four posts.
 *
 * The invariant, end to end: the request carries only posts on that list (the worldwide community's list for this key), at
 * most three, named by post, topic and number. Table: 0, 1, 3, 4 taps × another writer's post among the picks × a post gone
 * from the list (deleted since the form opened).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_GLOBAL_COMMUNITY_URL, FORUM_ASK_PICKER_WORDS, FORUM_ASK_POSTS_PATH, t } from '@beanpool/core';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { button: 'button', header: 'heading', checkbox: 'checkbox' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, disabled, accessibilityLabel, accessibilityRole, accessibilityState, testID, numberOfLines, style } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = (e: Event) => { e.stopPropagation(); onPress(); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (accessibilityState?.disabled) attrs['aria-disabled'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        const flat = Object.assign({}, ...[style].flat(3).filter((x) => x && typeof x === 'object'));
        if (typeof flat.minHeight === 'number') attrs['data-minh'] = String(flat.minHeight);
        if (typeof flat.color === 'string') attrs['data-color'] = flat.color;
        if (typeof flat.backgroundColor === 'string') attrs['data-bg'] = flat.backgroundColor;
        return createElement(tag, attrs, children as ReactNode);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('@expo/vector-icons', () => ({
    MaterialCommunityIcons: ({ name, color }: { name: string; color: string }) => createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: theme.dark ? 'dark' : 'light', colors: theme.dark ? darkColors : lightColors });
    return { useTheme: ctx, useStyles: (factory: (c: ReturnType<typeof ctx>) => unknown) => factory(ctx()) };
});
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
    },
}));
const guests = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('../nodes', () => ({ isGuestNode: async (url: string) => guests.list.includes(url) }));
const asked = vi.hoisted(() => [] as { url: string; path: string; key: string }[]);
const answer = vi.hoisted(() => ({ status: 200, body: null as unknown, fail: false }));
vi.mock('../node-post', () => ({
    signedPost: vi.fn(async () => new Response('{}')),
    signedGet: vi.fn(async (url: string, path: string, identity: { publicKey: string }) => {
        asked.push({ url, path, key: identity.publicKey });
        if (answer.fail) throw new TypeError('Network request failed');
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
    }),
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: vi.fn(async () => ({})) }));

import { useForumAskPicks, type ForumAskPicks } from '../forum-ask-picks';
import { KnockForumPicker } from '../../components/KnockForumPicker';
import { knockBody } from '../knock';
import { lightColors, darkColors } from '../../constants/colors';
import type { BeanPoolIdentity } from '../identity';

const ASHA = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Asha' } as unknown as BeanPoolIdentity;
const SECRET = 'cd'.repeat(32);
/** A topic title long enough to wrap at 320 px and 1.3× text. */
const LONG = 'A tool library for the hill, kept in the old scout hall, open on Saturday mornings';
const POSTS = [
    { postId: 'fp-a1', topicId: 'ft-tools', number: 1, title: LONG },
    { postId: 'fp-a2', topicId: 'ft-tools', number: 4, title: LONG },
    { postId: 'fp-a3', topicId: 'ft-bikes', number: 1, title: 'I can fix bikes on weekends' },
    { postId: 'fp-a4', topicId: 'ft-seeds', number: 7, title: 'Starting a seed library' },
];
const OWN = POSTS.map((p) => p.postId);
/** Ben's post: public on the forum, and not Asha's, so the worldwide community never lists it for her key. */
const OTHERS = 'fp-ben';
/** Asha's post, on the list when the form opened, deleted before she sent. */
const DELETED = 'fp-a5';

let root: Root | null = null;
let host: HTMLElement;
let picks: ForumAskPicks | null = null;
function Form({ formKey, identity }: { formKey: string | null; identity: BeanPoolIdentity | null }) {
    picks = useForumAskPicks(formKey, identity);
    return createElement(KnockForumPicker, { picks, testID: 'picker' });
}
async function settle() {
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function draw(formKey: string | null = 'riverside', identity: BeanPoolIdentity | null = ASHA) {
    root = createRoot(host);
    await act(async () => { root!.render(createElement(Form, { formKey, identity })); });
    await settle();
}
const rowOf = (id: string) => host.querySelector(`[data-testid="picker-${id}"]`) as HTMLElement | null;
/**
 * A tap on the row; a post with no row (not on the list) is handed to the hook's toggle anyway, as a stale tap would: the
 * hook refuses it a place, and the send rule (core forumAskSend through sendFor) would drop it, so the request never has it.
 */
async function tap(id: string) {
    const r = rowOf(id);
    await act(async () => { if (r) r.click(); else picks!.toggle(id); });
}
const sent = () => knockBody({ callsign: 'Asha', message: 'I fix bikes.', forum: picks!.sendFor(ASHA.publicKey) }, 'riverside.example', null);

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    store.clear();
    store.set('beanpool_anchor_url', DEFAULT_GLOBAL_COMMUNITY_URL);
    guests.list = [];
    asked.length = 0;
    Object.assign(answer, { status: 200, body: { secret: SECRET, posts: POSTS }, fail: false });
    theme.dark = false;
    picks = null;
});
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); });

describe('what the request sends, after taps on the picker', () => {
    const rows: { taps: string[]; sends: string[] }[] = [];
    for (const n of [0, 1, 3, 4]) {
        for (const withOthers of [false, true]) {
            for (const withDeleted of [false, true]) {
                rows.push({
                    taps: [...(withOthers ? [OTHERS] : []), ...OWN.slice(0, n), ...(withDeleted ? [DELETED] : [])],
                    sends: OWN.slice(0, Math.min(n, 3)),
                });
            }
        }
    }

    it.each(rows)('taps $taps -> sends $sends', async ({ taps, sends }) => {
        await draw();
        for (const id of taps) await tap(id);
        const body = sent();
        if (!sends.length) {
            expect(body).not.toHaveProperty('forumPosts');
            expect(body).not.toHaveProperty('forumSecret');
            return;
        }
        expect(body.forumPosts).toEqual(sends.map((id) => {
            const p = POSTS.find((x) => x.postId === id)!;
            return { postId: p.postId, topicId: p.topicId, number: p.number };
        }));
        expect(body.forumSecret).toBe(SECRET);
        expect(JSON.stringify(body)).not.toContain(LONG);
        expect(JSON.stringify(body)).not.toContain('title');
    });

    it('a post deleted after the form opened: the list read again leaves it out, and it is not sent', async () => {
        answer.body = { secret: SECRET, posts: [...POSTS, { postId: DELETED, topicId: 'ft-old', number: 2, title: 'Old' }] };
        await draw('riverside');
        await tap(DELETED);
        await tap('fp-a1');
        expect(sent().forumPosts?.map((p) => p.postId)).toEqual([DELETED, 'fp-a1']);
        // Asha closes the form and opens it again (or opens it for another community): the list is read again, without it.
        answer.body = { secret: SECRET, posts: POSTS };
        await act(async () => { root!.render(createElement(Form, { formKey: 'hilltop', identity: ASHA })); });
        await settle();
        expect(rowOf(DELETED)).toBeNull();
        expect(sent()).not.toHaveProperty('forumPosts');
        await tap('fp-a1');
        expect(sent().forumPosts?.map((p) => p.postId)).toEqual(['fp-a1']);
    });

    it('signed by another key than the one the list is for: nothing is sent', async () => {
        await draw();
        await tap('fp-a1');
        expect(picks!.sendFor('b'.repeat(64))).toBeNull();
        expect(picks!.sendFor(ASHA.publicKey)?.forumPosts).toHaveLength(1);
    });
});

describe('the picker at 320 px and 1.3× text', () => {
    it('asks the worldwide community once, signed with this key, and lists the posts with the forum’s title whole', async () => {
        await draw();
        expect(asked).toEqual([{ url: DEFAULT_GLOBAL_COMMUNITY_URL, path: FORUM_ASK_POSTS_PATH, key: ASHA.publicKey }]);
        const box = host.querySelector('[data-testid="picker"]')!;
        expect(box.querySelector('[role="heading"]')?.textContent).toBe(t(FORUM_ASK_PICKER_WORDS.heading));
        expect(box.textContent).toContain(t(FORUM_ASK_PICKER_WORDS.about));
        expect(box.querySelectorAll('[role="checkbox"]')).toHaveLength(4);
        const first = rowOf('fp-a1')!;
        expect(first.getAttribute('aria-checked')).toBe('false');
        expect(first.getAttribute('aria-label')).toBe(`${LONG}. Post 1`);
        expect(first.getAttribute('data-minh')).toBe('48');
        // The title wraps, whole, as the admins' rows show it: no line cap. "Post 4" tells two replies in one topic apart.
        expect(first.querySelector('[data-lines]')).toBeNull();
        expect(first.textContent).toBe(`${LONG}Post 1`);
        expect(rowOf('fp-a2')!.textContent).toBe(`${LONG}Post 4`);
    });

    it('a tap ticks a post, another takes it off; three ticked, the rest wait and the line says how to pick another', async () => {
        await draw();
        await tap('fp-a1');
        expect(rowOf('fp-a1')!.getAttribute('aria-checked')).toBe('true');
        expect(rowOf('fp-a1')!.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('checkbox-marked');
        await tap('fp-a1');
        expect(rowOf('fp-a1')!.getAttribute('aria-checked')).toBe('false');
        for (const id of ['fp-a1', 'fp-a2', 'fp-a3']) await tap(id);
        expect(rowOf('fp-a4')!.getAttribute('aria-disabled')).toBe('true');
        expect(host.querySelector('[data-testid="picker-full"]')?.textContent).toBe(t(FORUM_ASK_PICKER_WORDS.full));
        await tap('fp-a4');
        expect(rowOf('fp-a4')!.getAttribute('aria-checked')).toBe('false');
        await tap('fp-a2');
        expect(host.querySelector('[data-testid="picker-full"]')).toBeNull();
        await tap('fp-a4');
        expect(picks!.picked).toEqual(['fp-a1', 'fp-a3', 'fp-a4']);
    });

    it('light and dark: the words and the tick are drawn in that theme’s own tokens', async () => {
        for (const [dark, colours] of [[false, lightColors], [true, darkColors]] as const) {
            theme.dark = dark;
            await draw();
            await tap('fp-a1');
            const row = rowOf('fp-a1')!;
            expect(row.getAttribute('data-bg')).toBe(colours.surface.card);
            expect(Array.from(row.querySelectorAll('span'), (s) => s.getAttribute('data-color'))).toEqual([colours.text.heading, colours.text.secondary]);
            expect(row.querySelector('[data-icon]')?.getAttribute('data-color')).toBe(colours.brand.fill);
            expect(rowOf('fp-a2')!.querySelector('[data-icon]')?.getAttribute('data-color')).toBe(colours.text.muted);
            act(() => root?.unmount());
            root = null;
        }
    });
});

describe('nothing is drawn, and nothing sent, unless the list reads', () => {
    const cases: [string, () => void, boolean][] = [
        ['no posts on the worldwide forum', () => { answer.body = { secret: SECRET, posts: [] }; }, true],
        ['not a member there (403)', () => { answer.status = 403; answer.body = { code: 'not_member' }; }, true],
        ['the worldwide community unreachable', () => { answer.fail = true; }, true],
        ['an answer that is not the list', () => { answer.body = { posts: POSTS }; }, true],
        ['the phone is in a local community', () => { store.set('beanpool_anchor_url', 'https://riverside.example'); }, false],
        ['a guest on the worldwide community', () => { guests.list = [DEFAULT_GLOBAL_COMMUNITY_URL]; }, false],
        ['no community yet', () => { store.clear(); }, false],
    ];
    it.each(cases)('%s', async (_name, arrange, asks) => {
        arrange();
        await draw();
        expect(host.querySelector('[data-testid="picker"]')).toBeNull();
        expect(asked).toHaveLength(asks ? 1 : 0);
        expect(sent()).not.toHaveProperty('forumPosts');
    });

    it('no account (a key drafted for the request), or no form open: the worldwide community is asked nothing', async () => {
        await draw('riverside', null);
        expect(host.querySelector('[data-testid="picker"]')).toBeNull();
        act(() => root?.unmount());
        await draw(null, ASHA);
        expect(host.querySelector('[data-testid="picker"]')).toBeNull();
        expect(asked).toEqual([]);
    });
});
