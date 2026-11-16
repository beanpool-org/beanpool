/**
 * Every screen a link or a notice can open as the FIRST screen leaves to a real screen, never nowhere (review of #3228 at
 * 424fb857, round 3: a member's forum link opened on a cold start put the members' topic alone in the root Stack, and its ‹ and
 * its "topic gone" exit were a bare `router.back()`: nothing happened, and on iOS only a force-quit left it).
 *
 * One table: each such screen (utils/leave-screen.ts FIRST_SCREEN_EXITS) x (opened first, opened on top of Home) -> where its way
 * out lands, which must be a screen file Expo Router matches. Then the screens themselves: each leaves only through that table
 * (no bare `router.back()` left in it), and the table holds every screen the router (app/+native-intent.ts and the link readers
 * it calls) or a notice (utils/push-notice-check.ts) can name, so a new link target without a safe exit goes red here.
 *
 * Fails on 424fb857: app/forum/[id].tsx and app/chat/[id].tsx still have a bare `router.back()`, and neither leaves through the
 * table (the source rows), and FIRST_SCREEN_EXITS does not exist yet.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIRST_SCREEN_EXITS, leaveScreen, type FirstScreen } from '../leave-screen';
import { MEMBER_FORUM_LIST } from '../forum-link';

const appDir = path.resolve(__dirname, '../../app');
const utilsDir = path.resolve(__dirname, '..');

/** Every route file's URL path (Expo Router: groups dropped, `index` is its folder's path), against the file. */
function routePaths(dir = appDir, rel = ''): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(rel, entry.name);
        if (entry.isDirectory()) { out.push(...routePaths(path.join(dir, entry.name), file)); continue; }
        if (!/\.tsx?$/.test(entry.name) || /^(_layout|\+)/.test(entry.name) || /^[A-Z]/.test(entry.name)) continue;
        const url = file.replace(/\.tsx?$/, '').split(path.sep).filter((s) => !/^\(.*\)$/.test(s)).filter((s, i, all) => !(s === 'index' && i === all.length - 1)).join('/');
        out.push([url, file]);
    }
    return out;
}

/** The route file Expo Router matches for an href (a tab's own file before the start's for "/"), or null (Unmatched Route). */
function screenFor(href: string): string | null {
    const tabs = /^\/?\(tabs\)/.test(href);
    const p = href.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '').replace(/^\(tabs\)\/?/, '');
    const files = routePaths();
    const exact = files.filter(([url]) => url === p).map(([, f]) => f);
    if (exact.length) return exact.find((f) => tabs === f.startsWith(`(tabs)${path.sep}`)) ?? exact[0];
    const parent = p.split('/').slice(0, -1).join('/');
    const dynamic = files.find(([url]) => url.startsWith(parent ? `${parent}/` : '') && /^\[[^\]/]+\]$/.test(url.slice(parent ? parent.length + 1 : 0)));
    return dynamic ? dynamic[1] : null;
}

/** A root Stack as Expo Router keeps it, with the router's calls a screen makes. */
function stackOf(...routes: string[]) {
    const stack = [...routes];
    const router = {
        canGoBack: () => stack.length > 1,
        back: () => { if (stack.length > 1) stack.pop(); },
        replace: (href: never) => { stack[stack.length - 1] = href as unknown as string; },
    };
    return { stack, router };
}

const HOME = '/(tabs)';
const SCREENS = Object.keys(FIRST_SCREEN_EXITS) as FirstScreen[];

describe('each screen a link or a notice opens x (opened first, opened on top of Home) -> its way out lands on a real screen', () => {
    for (const screen of SCREENS) {
        it(`${screen}, opened first (a cold start): replaced by ${FIRST_SCREEN_EXITS[screen]}, a screen that exists`, () => {
            const { stack, router } = stackOf(`/${screen}`);
            leaveScreen(router, screen);
            expect(stack).toHaveLength(1);
            expect(stack[0]).toBe(FIRST_SCREEN_EXITS[screen]);
            expect(stack[0]).not.toBe(`/${screen}`);
            expect(screenFor(stack[0])).not.toBeNull();
        });
        it(`${screen}, opened on top of Home: back to Home`, () => {
            const { stack, router } = stackOf(HOME, `/${screen}`);
            leaveScreen(router, screen);
            expect(stack).toEqual([HOME]);
            expect(screenFor(stack[0])).toBe(path.join('(tabs)', 'index.tsx'));
        });
    }

    it('the members\' topic (the review\'s case): opened first, its ‹ and its "topic gone" exit land on the Forum side', () => {
        expect(FIRST_SCREEN_EXITS['forum/[id]']).toBe(MEMBER_FORUM_LIST);
        expect(screenFor(MEMBER_FORUM_LIST)).toBe(path.join('(tabs)', 'chats.tsx'));
    });

    it('a screen\'s own fallback (a claim with no account left, a door\'s new account) is a screen too', () => {
        const { stack, router } = stackOf('/claim-community');
        leaveScreen(router, 'claim-community', { fallback: '/welcome' });
        expect(stack).toEqual(['/welcome']);
        expect(screenFor('/welcome')).toBe('welcome.tsx');
    });

    it('two steps back (an enterprise cancelled: its page and its console both go) never leaves nothing', () => {
        const over = stackOf(HOME, '/treasury-detail', '/treasury-manage');
        leaveScreen(over.router, 'treasury-manage', { steps: 2 });
        expect(over.stack).toEqual([HOME]);
        const onHome = stackOf(HOME, '/treasury-manage');
        leaveScreen(onHome.router, 'treasury-manage', { steps: 2 });
        expect(onHome.stack).toEqual([HOME]);
        const first = stackOf('/treasury-manage');
        leaveScreen(first.router, 'treasury-manage', { steps: 2 });
        expect(first.stack).toEqual([FIRST_SCREEN_EXITS['treasury-manage']]);
    });
});

/** A screen file that only re-exports another (app/join-global.tsx is the door screen): the screen whose exits it has. */
function screenBehind(file: string): string {
    const src = fs.readFileSync(path.join(appDir, file), 'utf-8');
    const m = /^export \{ default[^}]*\} from '\.\/([^']+)';$/m.exec(src);
    return m && !/\n\s*(function|const|return)\b/.test(src) ? screenBehind(`${m[1]}.tsx`) : file;
}
const keyOf = (file: string) => file.replace(/\.tsx?$/, '').split(path.sep).join('/');

describe('each such screen leaves only through the table', () => {
    for (const screen of SCREENS) {
        it(`app/${screen}.tsx: every way out is leaveScreen(router, '${screen}'), no bare back`, () => {
            const file = path.join(appDir, `${screen}.tsx`);
            expect(fs.existsSync(file)).toBe(true);
            const src = fs.readFileSync(file, 'utf-8');
            expect(src).toMatch(/import \{ leaveScreen \} from '(\.\.\/)+utils\/leave-screen';/);
            expect(src).toContain(`leaveScreen(router, '${screen}'`);
            // No other way back that can do nothing on a first screen.
            expect(src.match(/router\.back\(\)|navigation\.goBack\(\)/g) ?? []).toEqual([]);
        });
    }
});

describe('the table holds every screen a link or a notice can name', () => {
    // The router and every link reader it calls, and the notices' routes. Tool reminders open a tool, which has its own way to its
    // first screen (app/tool/[id].tsx: opened straight at a record, it becomes the first), so it is not in this table.
    const SOURCES = [
        path.join(appDir, '+native-intent.ts'),
        ...['forum-link', 'peek-link', 'hall-link', 'claim-link', 'pair-link', 'pair-in', 'community-card-link', 'open-door', 'global-link',
            'push-notice-check', 'post-after-join', 'event-extras'].map((n) => path.join(utilsDir, `${n}.ts`)),
    ];
    const OWN_WAY = new Set(['tool/[id]']);
    /** Screens that are a first screen anyway (the tabs, the app's start, welcome): nothing under them to go back to. */
    const isStart = (file: string) => file.startsWith(`(tabs)${path.sep}`) || file === 'index.tsx' || file === 'welcome.tsx';

    it('every route a link reader or a notice builds lands on a screen in the table (or a tab, or the start)', () => {
        const named = new Map<string, string>();
        for (const src of SOURCES) {
            expect(fs.existsSync(src)).toBe(true);
            const text = fs.readFileSync(src, 'utf-8');
            for (const m of text.matchAll(/['`](\/(?:\(tabs\)\/?)?[a-z][a-z0-9-]*(?:\/(?:\$\{[^}]+\}|[a-z0-9[\]-]+))*)/g)) {
                const file = screenFor(m[1]);
                if (!file || isStart(file)) continue;
                named.set(keyOf(screenBehind(file)), `${m[1]} (${path.basename(src)})`);
            }
        }
        // The ones the review names are among them: the members' and the visitors' topic, a post (an event, a listing), a chat (a
        // person's, a group's), a group's invitation, My suggestions.
        for (const k of ['forum/[id]', 'forum-public/[id]', 'post/[id]', 'chat/[id]', 'group/[id]', 'learn/mine']) expect([...named.keys()]).toContain(k);
        const missing = [...named].filter(([k]) => !OWN_WAY.has(k) && !(k in FIRST_SCREEN_EXITS));
        expect(missing).toEqual([]);
    });

    it('a screen that only re-exports the door is read as the door (app/join-global.tsx)', () => {
        expect(screenBehind('join-global.tsx')).toBe('join-open-door.tsx');
        expect(screenBehind('peek.tsx')).toBe('peek.tsx');
    });
});
