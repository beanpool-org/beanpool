// @vitest-environment jsdom
/**
 * People → Invites → "Wants to join" on the phone, with forum posts on a request (forums F11; DESIGN-forums-fable.md §13, §14:
 * 320 px, 1.3× text). The web's twin is apps/pwa/src/components/KnockForumPosts.test.tsx; both draw the same rows, say the
 * same line for each outcome, and run the same table.
 *
 * The real components/WantsToJoin.tsx and components/KnockForumPosts.tsx, the real utils/knock-inbox.ts reader and the real
 * @beanpool/core check. The community's list and the worldwide forum's public JSON are a stubbed fetch, by address:
 *   - a post of the asker's own: its proof is the one the community kept ("Written by the same key that is asking ✓");
 *   - another person's: another proof ("Not written by the key that is asking");
 *   - removed, hidden, waiting, a new person's or a group's: the forum answers 404 ("This post isn't on the worldwide forum now");
 *   - the forum unreachable, or slower than the wait: "Could not check".
 * Nothing is asked of the worldwide forum before a tap, and the request's buttons work whatever the check says.
 *
 * Round 2 of #3242: every title, word, topic and number on a row is the forum's answer at the check, never the request's (the
 * list below carries made-up titles, as a hand-made request would, and they never show); the row's accessible label is its
 * headline and the check's line, so VoiceOver says the answer (a live region is Android's only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FORUM_ASK_CHECK_WORDS, FORUM_ASK_WORDS, forumAskPageUrl, readKnockForum, t, type ForumAskCheck, type KnockForum } from '@beanpool/core';
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
import { KnockForumPosts } from '../../components/KnockForumPosts';
import type { BeanPoolIdentity } from '../identity';

const ANCHOR = 'https://riverside.example';
const FORUM = 'https://forum.example';
const ME = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana' } as unknown as BeanPoolIdentity;
const MINE = FORUM_PROOF_VECTORS[0];
const OTHERS = FORUM_PROOF_VECTORS[1];
/** The forum's own title for the asker's topic: long, so it must wrap at 320 px and 1.3× text. */
const OWN_TITLE = 'Starting a seed library in a small town hall with neighbours';
/** Each row carries a title the asker made up, as a hand-made request would: none may ever show. */
const MADE_UP = 'Ran the seed swap for two years';

/** Five rows over two requests, one per outcome. Each topic id says how the worldwide forum answers it. */
const POSTS = {
    own: { postId: MINE.postId, topicId: 'ft-own', number: 2, title: MADE_UP, proof: MINE.proof },
    other: { postId: 'fp-other', topicId: 'ft-other', number: 1, title: MADE_UP, proof: MINE.proof },
    gone: { postId: 'fp-gone', topicId: 'ft-gone', number: 3, title: MADE_UP, proof: MINE.proof },
    down: { postId: 'fp-down', topicId: 'ft-down', number: 1, title: MADE_UP, proof: MINE.proof },
    slow: { postId: 'fp-slow', topicId: 'ft-slow', number: 1, title: MADE_UP, proof: MINE.proof },
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
        if (topic === 'ft-own') return Promise.resolve(json(200, { topic: { id: 'ft-own', title: OWN_TITLE }, posts: [{ id: MINE.postId, topicId: 'ft-own', number: 2, words: 'We started with one shelf.', proof: MINE.proof }] }));
        if (topic === 'ft-other') return Promise.resolve(json(200, { topic: { id: 'ft-other', title: 'Rainwater tanks' }, posts: [{ id: 'fp-other', topicId: 'ft-other', number: 1, words: 'Ben asks about tanks.', proof: OTHERS.proof }] }));
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
const lineOf = (knock: string, post: string) => host.querySelector(`[data-testid="knock-forum-check-${knock}-${post}"]`)?.textContent ?? null;
const buttonOf = (knock: string, post: string) => row(knock, post)?.querySelector('[role="button"]') as HTMLElement | null;
async function tap(knock: string, post: string) {
    const b = buttonOf(knock, post);
    if (!b) throw new Error(`no row ${knock}/${post}: ${host.innerHTML.slice(0, 400)}`);
    await act(async () => { b.click(); });
    await settle();
}

describe('forum posts under a request to join, on the phone at 320 px and 1.3× text', () => {
    it('draws one row a post saying only that a post was named, and asks the worldwide forum nothing before a tap', async () => {
        await draw();
        const own = row('k1', MINE.postId);
        expect(own?.textContent).toBe(`${FORUM_ASK_WORDS.named}›${FORUM_ASK_WORDS.tapToCheck}`);
        // The label is the headline and the line (which says what a tap does): no hint repeating it.
        const button = buttonOf('k1', MINE.postId)!;
        expect(button.getAttribute('aria-label')).toBe(`${FORUM_ASK_WORDS.named}. ${FORUM_ASK_WORDS.tapToCheck}`);
        expect(button.getAttribute('data-hint')).toBeNull();
        expect(own?.getAttribute('data-minh')).toBe('48');
        expect(host.textContent).not.toContain(MADE_UP);
        // A row that doesn't read (no proof) is not drawn; a request with none draws no rows.
        expect(row('k2', 'fp-x')).toBeNull();
        expect(host.querySelector('[data-testid^="knock-forum-k3"]')).toBeNull();
        expect(forumAsked).toEqual([]);
        expect(host.querySelector('[aria-label="Invite Asha"]')).not.toBeNull();
    });

    it("after a check that read the post: the forum's title, whole, and its words; the label carries the answer", async () => {
        await draw();
        await tap('k1', MINE.postId);
        const own = row('k1', MINE.postId)!;
        const headline = `From the worldwide forum: ${OWN_TITLE}`;
        expect(own.textContent).toContain(headline);
        expect(own.textContent).toContain('We started with one shelf.');
        // The title wraps: no line cap on it, at 320 px and 1.3× text (only the words are capped, at 6 lines).
        expect(Array.from(own.querySelectorAll('[data-lines]'), (el) => el.textContent)).toEqual(['We started with one shelf.']);
        expect(buttonOf('k1', MINE.postId)!.getAttribute('aria-label')).toBe(`${headline}. ${FORUM_ASK_CHECK_WORDS.same}`);
        expect(host.textContent).not.toContain(MADE_UP);
    });

    it('each outcome its line, in the label too: the same key ✓, another key, not there now, unreachable', async () => {
        await draw();
        const outcomes: [string, string, ForumAskCheck][] = [['k1', MINE.postId, 'same'], ['k1', 'fp-other', 'other'], ['k1', 'fp-gone', 'gone'], ['k2', 'fp-down', 'unknown']];
        for (const [knock, post, check] of outcomes) {
            await tap(knock, post);
            expect(lineOf(knock, post)).toBe(FORUM_ASK_CHECK_WORDS[check]);
            expect(buttonOf(knock, post)!.getAttribute('aria-label')).toContain(FORUM_ASK_CHECK_WORDS[check]);
        }
        expect(row('k1', 'fp-other')!.textContent).toContain('From the worldwide forum: Rainwater tanks');
        expect(row('k1', 'fp-gone')!.textContent).toBe(`${FORUM_ASK_WORDS.named}›${FORUM_ASK_CHECK_WORDS.gone}`);
        expect(forumAsked).toEqual([
            `${FORUM}/api/forum/public/topics/ft-own?after=1`, `${FORUM}/api/forum/public/topics/ft-other?after=0`,
            `${FORUM}/api/forum/public/topics/ft-gone?after=2`, `${FORUM}/api/forum/public/topics/ft-down?after=0`,
        ]);
        expect(host.textContent).not.toContain(MADE_UP);
    });

    it('slow: "Checking…" while it waits, then "Could not check" at the wait; the buttons answer meanwhile', async () => {
        await draw();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const b = buttonOf('k2', 'fp-slow')!;
        await act(async () => { b.click(); });
        expect(lineOf('k2', 'fp-slow')).toBe(FORUM_ASK_CHECK_WORDS.checking);
        expect(b.getAttribute('aria-busy')).toBe('true');
        expect(b.getAttribute('aria-label')).toBe(`${FORUM_ASK_WORDS.named}. ${FORUM_ASK_CHECK_WORDS.checking}`);
        expect(host.querySelector('[aria-label="Not now, Ben"]')).not.toBeNull();
        await act(async () => { vi.advanceTimersByTime(8_100); });
        vi.useRealTimers();
        await settle();
        expect(lineOf('k2', 'fp-slow')).toBe(FORUM_ASK_CHECK_WORDS.unknown);
    });

    it('"Open in the forum" lands where the forum has the post, after a check that found it; none for a post not there', async () => {
        await draw();
        await tap('k1', MINE.postId);
        await tap('k1', 'fp-gone');
        const link = row('k1', MINE.postId)?.querySelector('[role="link"]') as HTMLElement;
        expect(link?.getAttribute('aria-label')).toBe(FORUM_ASK_WORDS.open);
        await act(async () => { link.click(); });
        expect(opened).toEqual([forumAskPageUrl(FORUM, { topicId: 'ft-own', number: 2 })]);
        expect(row('k1', 'fp-gone')?.querySelector('[role="link"]')).toBeNull();
    });
});

/**
 * Closing the class, the phone's half (core runs the same table on knockForumRowView; the web runs it too):
 *   (a field a hand-made request carries: title, words, topicId, number) x (the forum's own value, a made-up one, empty)
 *   x (the check: the same key, another key, could not check) -> what the row shows and its label.
 * Every title, word, topic and number on the row is the forum's answer; the made-up values show nowhere.
 */
describe("closing the class: a row shows the forum's answer, never what the request carried", () => {
    const REAL = { title: 'Seed swap ideas', words: 'Bring seeds.', topicId: 'ft-1', number: 4 };
    const FAKE = { title: 'Ran the seed swap for two years', words: 'I organised every swap since 2019.', topicId: 'ft-madeup', number: 2 };
    const checks: Record<string, string | null> = { 'same key': MINE.proof, 'other key': OTHERS.proof, 'could not check': null };
    const cases = (['title', 'words', 'topicId', 'number'] as const)
        .flatMap((field) => (['forum', 'made up', 'empty'] as const).flatMap((value) => Object.keys(checks).map((check) => [field, value, check] as const)));

    it.each(cases)('%s · %s · %s', async (field, value, checkName) => {
        const proof = checks[checkName];
        vi.stubGlobal('fetch', vi.fn((url: string) => {
            if (proof === null) return Promise.reject(new TypeError('Network request failed'));
            const u = new URL(url);
            const after = Number(u.searchParams.get('after'));
            if (u.pathname.split('/').pop() !== REAL.topicId) return Promise.resolve(json(404, { code: 'not_found' }));
            const posts = REAL.number > after && REAL.number <= after + 30 ? [{ id: MINE.postId, topicId: REAL.topicId, number: REAL.number, words: REAL.words, proof }] : [];
            return Promise.resolve(json(200, { topic: { id: REAL.topicId, title: REAL.title }, posts }));
        }));
        const sent: Record<string, unknown> = { postId: MINE.postId, topicId: REAL.topicId, number: REAL.number, proof: MINE.proof };
        sent[field] = value === 'forum' ? REAL[field] : value === 'made up' ? FAKE[field] : field === 'number' ? undefined : '';
        const forum = readKnockForum({ at: FORUM, posts: [sent] });
        if (value === 'empty' && (field === 'topicId' || field === 'number')) { expect(forum).toBeNull(); return; }
        root = createRoot(host);
        await act(async () => { root!.render(createElement(KnockForumPosts, { forum: forum as KnockForum, knockId: 'k1' }) as any); });
        expect(row('k1', MINE.postId)!.textContent).toBe(`${FORUM_ASK_WORDS.named}›${FORUM_ASK_WORDS.tapToCheck}`);

        await tap('k1', MINE.postId);
        const want: ForumAskCheck = proof === null ? 'unknown' : field === 'topicId' && value === 'made up' ? 'gone' : proof === MINE.proof ? 'same' : 'other';
        const line = t(FORUM_ASK_CHECK_WORDS[want]);
        const read = want === 'same' || want === 'other';
        const headline = read ? t(FORUM_ASK_WORDS.fromForum, { title: REAL.title }) : t(FORUM_ASK_WORDS.named);
        const el = row('k1', MINE.postId)!;
        const label = buttonOf('k1', MINE.postId)!.getAttribute('aria-label');
        expect(el.textContent).toBe(`${headline}›${line}${read ? REAL.words : ''}${read || want === 'unknown' ? FORUM_ASK_WORDS.open : ''}`);
        expect(label).toBe(`${headline}. ${line}`);
        const link = el.querySelector('[role="link"]') as HTMLElement | null;
        if (link) await act(async () => { link.click(); });
        expect(opened).toEqual(read ? [forumAskPageUrl(FORUM, REAL)] : want === 'unknown' ? [forumAskPageUrl(FORUM, forum!.posts[0])] : []);
        for (const madeUp of [FAKE.title, FAKE.words, FAKE.topicId]) expect(`${el.textContent} ${label}`).not.toContain(madeUp);
    });
});
