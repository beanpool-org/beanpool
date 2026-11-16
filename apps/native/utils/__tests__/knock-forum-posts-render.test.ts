// @vitest-environment jsdom
/**
 * People → Invites → "Wants to join" on the phone, with forum posts on a request (forums F11; DESIGN-forums-fable.md §13, §14:
 * 320 px, 1.3× text). The web's twin is apps/pwa/src/components/KnockForumPosts.test.tsx; both draw the same rows and say the
 * same line for each outcome.
 *
 * The real components/WantsToJoin.tsx and components/KnockForumPosts.tsx, the real utils/knock-inbox.ts reader and the real
 * @beanpool/core check. The community's list and the worldwide forum's public JSON are a stubbed fetch, by address:
 *   - a post of the asker's own: its proof is the one the community kept ("Written by the same key that is asking ✓");
 *   - another person's: another proof ("Not written by the key that is asking");
 *   - removed, hidden, waiting, a new person's or a group's: the forum answers 404 ("This post isn't on the worldwide forum now");
 *   - the forum unreachable, or slower than the wait: "Could not check".
 * Nothing is asked of the worldwide forum before a tap, and the request's buttons work whatever the check says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FORUM_ASK_CHECK_WORDS, FORUM_ASK_WORDS, forumAskPageUrl } from '@beanpool/core';
import { FORUM_PROOF_VECTORS } from '@beanpool/core/forum-vectors';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const opened = vi.hoisted(() => [] as string[]);
vi.mock('react-native', () => {
    const roles: Record<string, string> = { button: 'button', header: 'heading', link: 'link' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, disabled, accessibilityLabel, accessibilityHint, accessibilityRole, accessibilityState, testID, numberOfLines, style } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = (e: Event) => { e.stopPropagation(); onPress(); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.busy !== undefined) attrs['aria-busy'] = String(accessibilityState.busy);
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        const flat = Object.assign({}, ...[style].flat(3).filter((x) => x && typeof x === 'object'));
        if (typeof flat.minHeight === 'number') attrs['data-minh'] = String(flat.minHeight);
        return createElement(tag, attrs, children as ReactNode);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        StyleSheet: { create: (s: unknown) => s },
        Linking: { openURL: async (url: string) => { opened.push(url); } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('../../app/ThemeContext', () => {
    const colours: any = new Proxy({}, { get: () => colours });
    return { useTheme: () => ({ colors: colours }), useStyles: (make: (t: { colors: unknown }) => unknown) => make({ colors: colours }) };
});
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../crypto', () => ({ buildSignedHeaders: vi.fn(async () => ({})) }));
vi.mock('../node-post', () => ({ signedPost: vi.fn(async () => new Response('{}')), signedGet: vi.fn(async () => new Response('null')) }));

import { WantsToJoin } from '../../components/WantsToJoin';
import type { BeanPoolIdentity } from '../identity';

const ANCHOR = 'https://riverside.example';
const FORUM = 'https://forum.example';
const ME = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana' } as unknown as BeanPoolIdentity;
const MINE = FORUM_PROOF_VECTORS[0];
const OTHERS = FORUM_PROOF_VECTORS[1];

/** Five rows over two requests, one per outcome. Each topic id says how the worldwide forum answers it. */
const POSTS = {
    own: { postId: MINE.postId, topicId: 'ft-own', number: 2, title: 'Starting a seed library in a small town hall with neighbours', proof: MINE.proof },
    other: { postId: 'fp-other', topicId: 'ft-other', number: 1, title: 'Rainwater tanks', proof: MINE.proof },
    gone: { postId: 'fp-gone', topicId: 'ft-gone', number: 3, title: 'A removed reply', proof: MINE.proof },
    down: { postId: 'fp-down', topicId: 'ft-down', number: 1, title: 'Bikes on Saturdays', proof: MINE.proof },
    slow: { postId: 'fp-slow', topicId: 'ft-slow', number: 1, title: 'Compost', proof: MINE.proof },
};
const KNOCKS = [
    { id: 'k1', pubkey: 'b'.repeat(64), callsign: 'Asha', message: 'I keep bees.', avatar: null, fromNode: null, createdAt: new Date().toISOString(), via: null,
        forum: { at: FORUM, posts: [POSTS.own, POSTS.other, POSTS.gone] } },
    { id: 'k2', pubkey: 'c'.repeat(64), callsign: 'Ben', message: 'I fix bikes.', avatar: null, fromNode: null, createdAt: new Date().toISOString(), via: null,
        forum: { at: FORUM, posts: [POSTS.down, POSTS.slow, { ...POSTS.own, postId: 'fp-x', proof: 'zz' }] } },
    { id: 'k3', pubkey: 'd'.repeat(64), callsign: 'Cy', message: 'Hello.', avatar: null, fromNode: null, createdAt: new Date().toISOString(), via: null, forum: null },
];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const forumAsked: string[] = [];
function serve() {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url.startsWith(ANCHOR)) return Promise.resolve(json(200, { knocks: KNOCKS, total: KNOCKS.length }));
        forumAsked.push(url);
        const topic = new URL(url).pathname.split('/').pop();
        if (topic === 'ft-own') return Promise.resolve(json(200, { posts: [{ id: MINE.postId, number: 2, words: 'We started with one shelf.', proof: MINE.proof }] }));
        if (topic === 'ft-other') return Promise.resolve(json(200, { posts: [{ id: 'fp-other', number: 1, words: 'Ben asks about tanks.', proof: OTHERS.proof }] }));
        if (topic === 'ft-gone') return Promise.resolve(json(404, { code: 'not_found' }));
        if (topic === 'ft-down') return Promise.reject(new TypeError('Network request failed'));
        return new Promise<Response>(() => { /* slow: never answers */ });
    }));
}

let root: Root | null = null;
let host: HTMLElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); forumAsked.length = 0; opened.length = 0; vi.useRealTimers(); });
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function settle() {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
async function draw() {
    serve();
    root = createRoot(host);
    await act(async () => { root!.render(createElement(WantsToJoin, { anchorUrl: ANCHOR, identity: ME }) as any); });
    await settle();
}
const row = (knock: string, post: string) => host.querySelector(`[data-testid="knock-forum-${knock}-${post}"]`) as HTMLElement | null;
const lineOf = (post: string) => host.querySelector(`[data-testid="knock-forum-check-${post}"]`)?.textContent ?? null;
async function tap(knock: string, post: string) {
    const b = row(knock, post)?.querySelector('[role="button"]') as HTMLElement | null;
    if (!b) throw new Error(`no row ${knock}/${post}: ${host.innerHTML.slice(0, 400)}`);
    await act(async () => { b.click(); });
    await settle();
}

describe('forum posts under a request to join, on the phone at 320 px and 1.3× text', () => {
    it('draws one row a post, its title whole, and asks the worldwide forum nothing before a tap', async () => {
        await draw();
        const title = `From the worldwide forum: ${POSTS.own.title}`;
        const own = row('k1', MINE.postId);
        expect(own?.textContent).toContain(title);
        const button = own?.querySelector('[role="button"]') as HTMLElement;
        expect(button.getAttribute('aria-label')).toBe(title);
        expect(button.getAttribute('data-hint')).toBe(FORUM_ASK_WORDS.tapToCheck);
        // The title wraps: no line cap anywhere on it, at 320 px and 1.3× text; the row is a 48 dp target.
        expect(own?.querySelector('[data-lines]')).toBeNull();
        expect(own?.getAttribute('data-minh')).toBe('48');
        expect(lineOf(MINE.postId)).toBe(FORUM_ASK_WORDS.tapToCheck);
        // A row that doesn't read (no proof) is not drawn; a request with none draws no rows.
        expect(row('k2', 'fp-x')).toBeNull();
        expect(host.querySelector('[data-testid^="knock-forum-k3"]')).toBeNull();
        expect(forumAsked).toEqual([]);
        expect(host.querySelector('[aria-label="Invite Asha"]')).not.toBeNull();
    });

    it('each outcome its line: the same key ✓, another key, not there now, unreachable, slow', async () => {
        await draw();
        await tap('k1', MINE.postId);
        expect(lineOf(MINE.postId)).toBe(FORUM_ASK_CHECK_WORDS.same);
        expect(row('k1', MINE.postId)?.textContent).toContain('We started with one shelf.');
        await tap('k1', 'fp-other');
        expect(lineOf('fp-other')).toBe(FORUM_ASK_CHECK_WORDS.other);
        await tap('k1', 'fp-gone');
        expect(lineOf('fp-gone')).toBe(FORUM_ASK_CHECK_WORDS.gone);
        await tap('k2', 'fp-down');
        expect(lineOf('fp-down')).toBe(FORUM_ASK_CHECK_WORDS.unknown);
        expect(forumAsked).toEqual([
            `${FORUM}/api/forum/public/topics/ft-own?after=1`, `${FORUM}/api/forum/public/topics/ft-other?after=0`,
            `${FORUM}/api/forum/public/topics/ft-gone?after=2`, `${FORUM}/api/forum/public/topics/ft-down?after=0`,
        ]);
    });

    it('slow: "Checking…" while it waits, then "Could not check" at the wait; the buttons answer meanwhile', async () => {
        await draw();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const b = row('k2', 'fp-slow')?.querySelector('[role="button"]') as HTMLElement;
        await act(async () => { b.click(); });
        expect(lineOf('fp-slow')).toBe(FORUM_ASK_CHECK_WORDS.checking);
        expect(b.getAttribute('aria-busy')).toBe('true');
        expect(host.querySelector('[aria-label="Not now, Ben"]')).not.toBeNull();
        await act(async () => { vi.advanceTimersByTime(8_100); });
        vi.useRealTimers();
        await settle();
        expect(lineOf('fp-slow')).toBe(FORUM_ASK_CHECK_WORDS.unknown);
    });

    it('"Open in the forum" lands on the post, after a check that found it; none for a post not there', async () => {
        await draw();
        await tap('k1', MINE.postId);
        await tap('k1', 'fp-gone');
        const link = row('k1', MINE.postId)?.querySelector('[role="link"]') as HTMLElement;
        expect(link?.getAttribute('aria-label')).toBe(FORUM_ASK_WORDS.open);
        await act(async () => { link.click(); });
        expect(opened).toEqual([forumAskPageUrl(FORUM, POSTS.own)]);
        expect(row('k1', 'fp-gone')?.querySelector('[role="link"]')).toBeNull();
    });
});
