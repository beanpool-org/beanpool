/**
 * The asker's picker on Ask to join, on the web (forums F11b; DESIGN-forums-fable.md §13, §14: 320 px, light and dark). The
 * phone's twin is apps/native/utils/__tests__/knock-forum-picker-render.test.ts; the admins' side of the same posts is
 * KnockForumPosts.test.tsx.
 *
 * The real components/AskToJoin.tsx form, components/KnockForumPicker.tsx, lib/forum-ask-picks.ts and lib/knock.ts, over a
 * stubbed fetch by address: this web app's own server (the worldwide community) answers GET /api/forum/ask-posts with Asha's
 * four posts, and the community asked takes the request. Each case ends in the request's body as the community receives it.
 *
 * The invariant, end to end: the request carries only posts on that list (the worldwide community's list for this key), at
 * most three, named by post, topic and number. Table: 0, 1, 3, 4 taps × another writer's post among the picks × a post gone
 * from the list (deleted since the form opened).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { FORUM_ASK_PICKER_WORDS, FORUM_ASK_POSTS_PATH, t } from '@beanpool/core';
import { AskToJoin } from './AskToJoin';
import { useForumAskPicks } from '../lib/forum-ask-picks';
import { knockBody } from '../lib/knock';
import type { BeanPoolIdentity } from '../lib/identity';
import { hearNodeVersionForTests, resetNodeVersionGateForTests } from '../lib/node-version-gate';

const ASHA = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Asha', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const OWN_SERVER = 'https://worldwide.example.org';
const RIVERSIDE = { key: 'r', name: 'Riverside', url: 'https://riverside.example.org' };
const SECRET = 'cd'.repeat(32);
/** A topic title of the forum's longest kind: it wraps at 320 px. */
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
/** Asha's post, deleted before the form opened: the list read then doesn't have it. */
const DELETED = 'fp-a5';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let list: () => Response | Promise<Response>;
let calls: Array<{ url: string; method: string; body: any }>;
function serve() {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url === `${OWN_SERVER}${FORUM_ASK_POSTS_PATH}`) return list();
        if (url === `${RIVERSIDE.url}/api/join/knock`) return json(201, { knock: { status: 'pending' } });
        throw new TypeError(`unexpected fetch ${url}`);
    }));
}
const asks = () => calls.filter((c) => c.url.endsWith(FORUM_ASK_POSTS_PATH));
const knock = () => calls.find((c) => c.url.endsWith('/api/join/knock'))?.body;

async function openForm(forumPicker = true, withList = true) {
    render(<AskToJoin community={RIVERSIDE} identity={ASHA} asked={false} forumPicker={forumPicker} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join Riverside' }));
    fireEvent.change(screen.getByLabelText('A few words about yourself'), { target: { value: 'I fix bikes in my shed.' } });
    if (withList) await screen.findByRole('group', { name: t(FORUM_ASK_PICKER_WORDS.heading) });
    else await waitFor(() => expect(asks()).toHaveLength(forumPicker ? 1 : 0));
}
const box = () => screen.queryByTestId('ask-to-join-r-forum');
const rowOf = (id: string) => screen.queryByTestId(`ask-to-join-r-forum-${id}`);
function tap(id: string) {
    const r = rowOf(id);
    if (r) fireEvent.click(r); // a post not on the list has no row to tap
}
async function send() {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(knock()).toBeDefined());
    return knock();
}

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('bp_node_url', OWN_SERVER);
    resetNodeVersionGateForTests();
    hearNodeVersionForTests(OWN_SERVER);
    hearNodeVersionForTests(RIVERSIDE.url);
    list = () => json(200, { secret: SECRET, posts: POSTS });
    serve();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

/** 0, 1, 3, 4 of Asha's own × another writer's post × a deleted one; what goes is only hers, in order, at most three. */
function rows(): { taps: string[]; sends: string[] }[] {
    const out: { taps: string[]; sends: string[] }[] = [];
    for (const n of [0, 1, 3, 4]) {
        for (const withOthers of [false, true]) {
            for (const withDeleted of [false, true]) {
                out.push({
                    taps: [...(withOthers ? [OTHERS] : []), ...OWN.slice(0, n), ...(withDeleted ? [DELETED] : [])],
                    sends: OWN.slice(0, Math.min(n, 3)),
                });
            }
        }
    }
    return out;
}

describe('what the request sends, after taps on the picker', () => {
    it.each(rows())('taps $taps -> sends $sends', async ({ taps, sends }) => {
        await openForm();
        for (const id of taps) tap(id);
        const body = await send();
        if (!sends.length) {
            expect(body).not.toHaveProperty('forumPosts');
            expect(body).not.toHaveProperty('forumSecret');
        } else {
            expect(body.forumPosts).toEqual(sends.map((id) => {
                const p = POSTS.find((x) => x.postId === id)!;
                return { postId: p.postId, topicId: p.topicId, number: p.number };
            }));
            expect(body.forumSecret).toBe(SECRET);
            expect(JSON.stringify(body)).not.toContain(LONG);
            expect(JSON.stringify(body)).not.toContain('title');
        }
        expect(body).toMatchObject({ message: 'I fix bikes in my shed.', callsign: 'Asha', toNode: 'riverside.example.org' });
        // The list was asked of this web app's own server, once, signed (never of the community asked).
        expect(asks().map((c) => c.url)).toEqual([`${OWN_SERVER}${FORUM_ASK_POSTS_PATH}`]);
    });
});

describe('the send rule behind the form: picks that are not on the list never go', () => {
    // The form has no row for another writer's post or a deleted one, and holds a fourth row back; here they are handed to the
    // hook's toggle anyway (a stale tap): it refuses them a place, and the send rule (core forumAskSend) would drop them.
    it.each(rows())('picks $taps -> sends $sends', async ({ taps, sends }) => {
        const { result } = renderHook(() => useForumAskPicks(true, ASHA));
        await waitFor(() => expect(result.current.offered).not.toBeNull());
        for (const id of taps) act(() => result.current.toggle(id));
        const body = knockBody({ callsign: 'Asha', message: 'Hi', forum: result.current.sendFor(ASHA.publicKey) }, 'riverside.example.org');
        expect(body.forumPosts?.map((p) => p.postId) ?? []).toEqual(sends);
        expect(result.current.sendFor('b'.repeat(64))).toBeNull();
    });
});

describe('the picker at 320 px, light and dark', () => {
    it('lists the posts under the form, the forum’s title whole, and where each post is in its topic', async () => {
        await openForm();
        const group = box()!;
        expect(within(group).getByText(t(FORUM_ASK_PICKER_WORDS.about))).toBeTruthy();
        expect(within(group).getAllByRole('checkbox')).toHaveLength(4);
        const first = rowOf('fp-a1')!;
        expect(first.getAttribute('aria-checked')).toBe('false');
        expect(first.textContent).toBe(`${LONG} Post 1`);
        expect(within(group).getByRole('checkbox', { name: `${LONG} Post 4` })).toBe(rowOf('fp-a2'));
        // Wraps at 320 px: no line cap on the title, a 48 px target, and the box never wider than the form.
        const title = within(first).getByText(LONG);
        expect(title.className).toContain('break-words');
        expect(title.className).not.toMatch(/truncate|line-clamp/);
        expect(first.className).toContain('min-h-[48px]');
        expect(first.className).toContain('min-w-0');
        // Each colour has its dark pair (the shop's tick, the same tokens).
        for (const el of [first, title, within(group).getByText(t(FORUM_ASK_PICKER_WORDS.about))]) {
            const light = el.className.split(/\s+/).filter((c) => /^(bg|text|border)-nature-/.test(c));
            const dark = el.className.split(/\s+/).filter((c) => /^dark:(bg|text|border)-/.test(c));
            expect(light.length).toBeGreaterThan(0);
            expect(dark.length).toBeGreaterThanOrEqual(light.length);
        }
        // Under the words about yourself, above Send.
        const form = screen.getByTestId('ask-to-join-r-form');
        const order = Array.from(form.querySelectorAll('textarea, fieldset, button[type="submit"]'), (el) => el.tagName);
        expect(order).toEqual(['TEXTAREA', 'FIELDSET', 'BUTTON']);
    });

    it('a tap ticks a post, another takes it off; three ticked, the rest wait and the line says how to pick another', async () => {
        await openForm();
        tap('fp-a1');
        expect(rowOf('fp-a1')!.getAttribute('aria-checked')).toBe('true');
        expect(rowOf('fp-a1')!.textContent?.startsWith('✓')).toBe(true);
        tap('fp-a1');
        expect(rowOf('fp-a1')!.getAttribute('aria-checked')).toBe('false');
        for (const id of ['fp-a1', 'fp-a2', 'fp-a3']) tap(id);
        expect((rowOf('fp-a4') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByRole('status').textContent).toBe(t(FORUM_ASK_PICKER_WORDS.full));
        tap('fp-a2');
        expect(screen.queryByTestId('ask-to-join-r-forum-full')).toBeNull();
        tap('fp-a4');
        const body = await send();
        expect(body.forumPosts.map((p: { postId: string }) => p.postId)).toEqual(['fp-a1', 'fp-a3', 'fp-a4']);
    });

    it('Cancel drops the picks: opened again, the list is read again and nothing is ticked', async () => {
        await openForm();
        tap('fp-a1');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        list = () => json(200, { secret: SECRET, posts: POSTS.slice(1) });
        fireEvent.click(screen.getByRole('button', { name: 'Ask to join Riverside' }));
        await waitFor(() => expect(rowOf('fp-a2')).not.toBeNull());
        expect(rowOf('fp-a1')).toBeNull();
        expect(asks()).toHaveLength(2);
        fireEvent.change(screen.getByLabelText('A few words about yourself'), { target: { value: 'I fix bikes in my shed.' } });
        expect(await send()).not.toHaveProperty('forumPosts');
    });
});

describe('nothing is drawn, and nothing sent, unless the list reads', () => {
    const cases: [string, () => Response | Promise<Response>][] = [
        ['no posts on the worldwide forum', () => json(200, { secret: SECRET, posts: [] })],
        ['this server is not the worldwide community (404 not_here)', () => json(404, { code: 'not_here' })],
        ['not a member there (403)', () => json(403, { code: 'not_member' })],
        ['unreachable', () => Promise.reject(new TypeError('Failed to fetch'))],
        ['an answer that is not the list', () => json(200, { posts: POSTS })],
    ];
    it.each(cases)('%s', async (_name, answer) => {
        list = answer;
        await openForm(true, false);
        await new Promise((r) => setTimeout(r, 0));
        expect(box()).toBeNull();
        const body = await send();
        expect(body).not.toHaveProperty('forumPosts');
        expect(body).not.toHaveProperty('forumSecret');
    });

    it('a server whose forum is not the worldwide one (Home’s answer): the list is never asked for', async () => {
        await openForm(false, false);
        expect(box()).toBeNull();
        const body = await send();
        expect(body).not.toHaveProperty('forumPosts');
        expect(asks()).toEqual([]);
    });
});
