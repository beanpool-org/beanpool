// @vitest-environment jsdom
/**
 * Where a member lands when they come off the welcome screen (utils/member-landing.ts, app/_layout.tsx's root guard).
 *
 * After a community restore in a vault build the member must land on Settings, whose first card is the move (PR #1336
 * review finding 3); everywhere else, and in a build without a vault, on the tabs' index as before. The welcome screen
 * used to `router.replace('/(tabs)/settings')` itself, and the member landed on the index: expo-router's `replace`
 * only queues, the queue runs in a passive effect of its NavigationContainer (an ancestor of the root layout), and in
 * the commit that brings the identity the root guard's own welcome→tabs replace is queued behind the screen's
 * (PR #1357 deciding review, 4147422745, measured on this same model).
 *
 * The model, from the installed expo-router 55 and @react-navigation/core 7.16, rendered with the real React 19.2
 * reconciler (react-dom, whose update lanes match React Native's renderer):
 * - the navigation state is a `useSyncExternalStore` store, and the container reports a change in a passive effect;
 * - `useSegments()` reads a route info set while the focused screen renders, and on that report;
 * - `router.replace` adds to a routing queue that an effect of the outer container runs.
 * The root guard's effect calls the real `memberRedirect`, as app/_layout.tsx does; the welcome screen's tail is the
 * one app/welcome.tsx `handleSsoRecoverAtCommunity` runs. Both are tied to their sources below.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createContext, createElement as h, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    DEFAULT_MEMBER_LANDING, guestRedirect, landNextOn, memberRedirect, NOTICE_LANDING_MS, openAfterLanding, takeOpenAfterLanding,
} from '../member-landing';

type Route = 'welcome' | '(tabs)/index' | '(tabs)/settings';

/** The expo-router href as the navigator resolves it. */
function resolve(href: string): Route {
    if (href === '/' || href === '/(tabs)') return '(tabs)/index';
    if (href === '/(tabs)/settings') return '(tabs)/settings';
    if (href === '/welcome') return 'welcome';
    throw new Error(`unmodelled href ${href}`);
}
/** `useSegments()` for a route: the index's own segment is left out. */
const SEGMENTS: Record<Route, string[]> = { welcome: ['welcome'], '(tabs)/index': ['(tabs)'], '(tabs)/settings': ['(tabs)', 'settings'] };

/** How the welcome screen ends a community restore: e90e6f4f's way, or the way it does now. */
type Ending = 'now' | 'e90e6f4f';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    memberRedirect(['welcome']); // nothing left over from another test
});
afterEach(() => {
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
});

/** Renders the app on welcome, runs a community restore's end, and says where the member is once all has settled. */
async function restoreAtCommunity({ vault, ending = 'now' }: { vault: boolean; ending?: Ending }): Promise<{ landed: Route; log: string[] }> {
    const log: string[] = [];

    // React Navigation's state store (useSyncState).
    let navState: Route = 'welcome';
    const navListeners = new Set<() => void>();
    const nav = {
        get: () => navState,
        subscribe: (cb: () => void) => { navListeners.add(cb); return () => { navListeners.delete(cb); }; },
        replace: (to: Route) => { log.push(`navigate ${to}`); navState = to; navListeners.forEach((l) => l()); },
    };
    // expo-router's store: route info set during the focused screen's render, and notified on the container's report.
    let routeInfo = SEGMENTS.welcome;
    const infoListeners = new Set<() => void>();
    const store = {
        subscribe: (cb: () => void) => { infoListeners.add(cb); return () => { infoListeners.delete(cb); }; },
        get: () => routeInfo,
        setFocused: (r: Route) => { routeInfo = SEGMENTS[r]; },
        onStateChange: (r: Route) => { routeInfo = SEGMENTS[r]; infoListeners.forEach((l) => l()); },
    };
    // expo-router 55 global-state/routing.js: linkTo adds to the routing queue; imperative-api.js runs it in a passive
    // effect of its NavigationContainer.
    let queue: Route[] = [];
    const queueListeners = new Set<() => void>();
    const routing = {
        subscribe: (cb: () => void) => { queueListeners.add(cb); return () => { queueListeners.delete(cb); }; },
        snapshot: () => queue,
        add: (to: Route) => { queue = [...queue, to]; queueListeners.forEach((l) => l()); },
        run: () => { const events = queue; queue = []; for (const to of events) nav.replace(to); },
    };
    const router = { replace: (href: string) => { log.push(`router.replace(${href})`); routing.add(resolve(href)); } };

    type Id = { publicKey: string } | null;
    const NavState = createContext<Route>('welcome');
    const Identity = createContext<{ identity: Id; setIdentity: (id: Id) => void }>({ identity: null, setIdentity: () => {} });

    function RouterContainer({ children }: { children: ReactNode }) {
        const events = useSyncExternalStore(routing.subscribe, routing.snapshot);
        useEffect(() => { if (events.length) routing.run(); }, [events]);
        return h(NavigationContainer, null, children);
    }
    function NavigationContainer({ children }: { children: ReactNode }) {
        const state = useSyncExternalStore(nav.subscribe, nav.get);
        const first = useRef(true);
        useEffect(() => {
            if (!first.current) store.onStateChange(state);
            first.current = false;
        }, [state]);
        return h(NavState.Provider, { value: state }, children);
    }
    function IdentityProvider({ children }: { children: ReactNode }) {
        const [identity, setIdentity] = useState<Id>(null);
        return h(Identity.Provider, { value: { identity, setIdentity } }, children);
    }
    /** app/_layout.tsx RootLayoutNav's guard: its no-identity check and its last one (the rest act on a node's answer). */
    function RootLayoutNav() {
        const { identity } = useContext(Identity);
        const segments = useSyncExternalStore(store.subscribe, store.get);
        useEffect(() => {
            if (!identity) {
                if (segments[0] !== 'welcome') setTimeout(() => router.replace('/welcome'), 50);
                return;
            }
            const landing = memberRedirect(segments);
            if (landing) router.replace(landing);
        }, [identity, segments]);
        return h(Stack);
    }
    function Stack() {
        const route = useContext(NavState);
        return h(Screen, { key: route, route });
    }
    function Screen({ route }: { route: Route }) {
        store.setFocused(route);
        return route === 'welcome' ? h(Welcome) : h('div', null, route);
    }
    function Welcome() {
        const { setIdentity } = useContext(Identity);
        const [, setMode] = useState('ssoRecover');
        useEffect(() => {
            // The restore resolves a while after the tap: an async continuation, outside any React event.
            setTimeout(() => {
                void Promise.resolve().then(() => {
                    const identity = { publicKey: 'pk' };
                    if (ending === 'e90e6f4f') {
                        setIdentity(identity);
                        setMode('home');
                        router.replace(vault ? '/(tabs)/settings' : '/');
                        return;
                    }
                    // app/welcome.tsx handleSsoRecoverAtCommunity, after the restore (tied to the source below).
                    if (vault) landNextOn('/(tabs)/settings');
                    setIdentity(identity);
                    setMode('home');
                    if (!vault) router.replace('/');
                });
            }, 10);
        }, []);
        return h('div', null, 'welcome');
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // react-dom's types carry their own copy of @types/react; the element is the same.
    root.render(h(RouterContainer, null, h(IdentityProvider, null, h(RootLayoutNav))) as Parameters<Root['render']>[0]);
    await new Promise((r) => setTimeout(r, 300));
    return { landed: nav.get(), log };
}

describe('the landing after a community restore', () => {
    it('in a vault build: Settings, whose first card is the move, and it stays there', async () => {
        const { landed, log } = await restoreAtCommunity({ vault: true });
        expect(landed).toBe('(tabs)/settings');
        expect(log).toEqual(['router.replace(/(tabs)/settings)', 'navigate (tabs)/settings']);
        // Taken once: the next landing from welcome is the index again.
        expect(memberRedirect(['welcome'])).toBe('/(tabs)');
    });

    it("in a build without a vault: the tabs' index, as on main", async () => {
        const { landed, log } = await restoreAtCommunity({ vault: false });
        expect(landed).toBe('(tabs)/index');
        expect(log).toEqual(['router.replace(/)', 'router.replace(/(tabs))', 'navigate (tabs)/index', 'navigate (tabs)/index']);
    });

    it("e90e6f4f's way, the welcome screen replacing to Settings itself, lands on the index: the model holds the race", async () => {
        const { landed, log } = await restoreAtCommunity({ vault: true, ending: 'e90e6f4f' });
        expect(landed).toBe('(tabs)/index');
        // The screen's replace is queued first, the guard's behind it, and the container runs both in order.
        expect(log).toEqual(['router.replace(/(tabs)/settings)', 'router.replace(/(tabs))', 'navigate (tabs)/settings', 'navigate (tabs)/index']);
    });
});

describe('memberRedirect: the root guard\'s landing from welcome', () => {
    it("the tabs' index from welcome or the bare root, when nothing was asked", () => {
        expect(DEFAULT_MEMBER_LANDING).toBe('/(tabs)');
        expect(memberRedirect(['welcome'])).toBe('/(tabs)');
        expect(memberRedirect([])).toBe('/(tabs)');
    });

    it('a landing asked for is taken once, from welcome or the bare root', () => {
        landNextOn('/(tabs)/settings');
        expect(memberRedirect(['welcome'])).toBe('/(tabs)/settings');
        expect(memberRedirect(['welcome'])).toBe('/(tabs)');
        landNextOn('/(tabs)/settings');
        expect(memberRedirect([])).toBe('/(tabs)/settings');
        expect(memberRedirect([])).toBe('/(tabs)');
    });

    it('anywhere else: stay, and the landing asked for is kept for the landing from welcome', () => {
        landNextOn('/(tabs)/settings');
        expect(memberRedirect(['(tabs)'])).toBeNull();
        expect(memberRedirect(['(tabs)', 'settings'])).toBeNull();
        expect(memberRedirect(['node-mismatch'])).toBeNull();
        expect(memberRedirect(['welcome'])).toBe('/(tabs)/settings');
    });
});

describe('a claim no longer waits for an account made elsewhere: the claim makes it (DESIGN-account-without-global §2.2)', () => {
    // #2412's detour kept the claim for an account made by another door, and every landing from welcome went back to the
    // claim screen for a day. The claim screen makes the account now, and a claim whose answer is not in is the wizard's
    // record, which the guard holds on the claim screen itself (auth-return.ts setupRedirect `claimOut`).
    it('from welcome or the bare root, any account lands on the tabs, or on the landing asked for, taken once', () => {
        for (const key of ['pk-a', 'pk-b', null]) {
            expect(memberRedirect(['welcome'], key)).toBe('/(tabs)');
            expect(memberRedirect([], key)).toBe('/(tabs)');
        }
        landNextOn('/(tabs)/settings');
        expect(memberRedirect(['welcome'])).toBe('/(tabs)/settings');
        expect(memberRedirect(['welcome'])).toBe('/(tabs)');
    });

    it('the claim screen, like anywhere else but welcome: stay', () => {
        for (const segments of [['(tabs)'], ['claim-community'], ['node-mismatch']]) expect(memberRedirect(segments, 'pk-a')).toBeNull();
    });

    it('nothing in the module lands on a claim any more', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../member-landing.ts'), 'utf8');
        expect(src).not.toMatch(/landOnClaim|ClaimLanding|claim-community/);
    });
});

describe('a landing is only for the account it was asked for (PR #1357 confirmation, N1)', () => {
    it('asked for A, then Sign Out and B restored: B lands on the index, and A\'s landing is gone', () => {
        landNextOn('/(tabs)/settings', 'key-A');
        // The node called A a stranger: the guard never reached its landing, then A signed out and B came back.
        expect(memberRedirect(['welcome'], 'key-B')).toBe('/(tabs)');
        expect(memberRedirect(['welcome'], 'key-A')).toBe('/(tabs)');
    });

    it('dropped even while another account sits elsewhere in the app', () => {
        landNextOn('/(tabs)/settings', 'key-A');
        expect(memberRedirect(['(tabs)'], 'key-B')).toBeNull();
        expect(memberRedirect(['welcome'], 'key-A')).toBe('/(tabs)');
    });

    it('the account it was asked for still lands on it', () => {
        landNextOn('/(tabs)/settings', 'key-A');
        expect(memberRedirect(['(tabs)'], 'key-A')).toBeNull();
        expect(memberRedirect(['welcome'], 'key-A')).toBe('/(tabs)/settings');
    });
});

describe('a tapped notice opens after the landing, for its community and account only (push-notice-switch.ts)', () => {
    const BYRON = 'https://byron.example.net';
    const NOW = 1_800_000_000_000;

    it('taken once, by the account it was asked for, with its community in use (written with or without a trailing slash)', () => {
        openAfterLanding('/post/3f2b8c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b', BYRON, 'key-A', NOW);
        expect(takeOpenAfterLanding('key-A', 'https://mullum.beanpool.org', NOW)).toBeNull();
        expect(takeOpenAfterLanding('key-A', null, NOW)).toBeNull();
        expect(takeOpenAfterLanding('key-A', `${BYRON}/`, NOW + 1000)).toBe('/post/3f2b8c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b');
        expect(takeOpenAfterLanding('key-A', BYRON, NOW + 1000)).toBeNull();
    });

    it('another account on the phone drops it; so does its time running out', () => {
        openAfterLanding('/(tabs)/chats', BYRON, 'key-A', NOW);
        expect(takeOpenAfterLanding('key-B', BYRON, NOW)).toBeNull();
        expect(takeOpenAfterLanding('key-A', BYRON, NOW)).toBeNull();
        openAfterLanding('/(tabs)/chats', BYRON, 'key-A', NOW);
        expect(takeOpenAfterLanding('key-A', BYRON, NOW + NOTICE_LANDING_MS)).toBeNull();
        expect(takeOpenAfterLanding('key-A', BYRON, NOW + 1)).toBeNull();
    });

    it('the latest tap replaces any before it', () => {
        openAfterLanding('/(tabs)/chats', BYRON, 'key-A', NOW);
        openAfterLanding('/(tabs)/market', BYRON, 'key-A', NOW);
        expect(takeOpenAfterLanding('key-A', BYRON, NOW)).toBe('/(tabs)/market');
    });

    it('leaves the landings from welcome as they were', () => {
        openAfterLanding('/(tabs)/chats', BYRON, 'key-A', NOW);
        expect(memberRedirect(['welcome'], 'key-A')).toBe(DEFAULT_MEMBER_LANDING);
        expect(guestRedirect(['welcome'], 'key-A')).toBeNull();
        expect(takeOpenAfterLanding('key-A', BYRON, NOW)).toBe('/(tabs)/chats');
    });
});

describe('guestRedirect: a chosen guest the root guard finds on welcome (PR #2320 review)', () => {
    it('nothing asked: null, and the guest stays (on welcome to use an invite for that community, say)', () => {
        expect(guestRedirect(['welcome'], 'key-A')).toBeNull();
        expect(guestRedirect(['welcome'])).toBeNull();
    });

    it('a landing asked for is taken once, from welcome only; anywhere else it is kept', () => {
        landNextOn('/(tabs)', 'key-A');
        expect(guestRedirect(['(tabs)'], 'key-A')).toBeNull();
        expect(guestRedirect(['node-mismatch'], 'key-A')).toBeNull();
        expect(guestRedirect([], 'key-A')).toBeNull();
        expect(guestRedirect(['welcome'], 'key-A')).toBe('/(tabs)');
        expect(guestRedirect(['welcome'], 'key-A')).toBeNull();
    });

    it('only for the account it was asked for: another account drops it', () => {
        landNextOn('/(tabs)', 'key-A');
        expect(guestRedirect(['welcome'], 'key-B')).toBeNull();
        expect(guestRedirect(['welcome'], 'key-A')).toBeNull();
    });

    it("one ask: a member's landing from welcome takes it, so none is left for a later guest", () => {
        landNextOn('/(tabs)', 'key-A');
        expect(memberRedirect(['welcome'], 'key-A')).toBe('/(tabs)');
        expect(guestRedirect(['welcome'], 'key-A')).toBeNull();
    });
});

describe('the model is the app', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

    // Since 24 Oct the guard's last two lines open, over the tabs' index only, a notice tapped from the community the phone
    // just moved to for it (push-notice-switch.test.ts drives that); the landing itself is as before.
    it("app/_layout.tsx's guard ends by landing where memberRedirect says, and replaces to the tabs nowhere else from welcome", () => {
        const layout = read('../../app/_layout.tsx');
        const guard = layout.slice(layout.indexOf('        if (isLoading) return;\n        const root = (segments as string[])[0];'));
        // Since S3 the guard also looks again when the phone's community comes or goes (`noCommunity`, a waiting phone).
        const body = guard.slice(0, guard.indexOf('}, [identity, isLoading, segments, recognition, pendingOnboarding, noCommunity]);'));
        expect(body).toMatch(/\n\s*const landing = memberRedirect\(segments as string\[\], identity\.publicKey\);\n\s*if \(landing\) router\.replace\(landing\);\n\s*const notice = landing === DEFAULT_MEMBER_LANDING \? takeOpenAfterLanding\(identity\.publicKey, nodeUrl\) : null;\n\s*if \(notice\) router\.push\(notice\);\n\s*$/);
        expect(body).not.toMatch(/root === 'welcome'\) \{\s*router\.replace/);
    });

    it("app/welcome.tsx's community restore asks for Settings before setting the identity, and never navigates there itself", () => {
        const welcome = read('../../app/welcome.tsx');
        const at = welcome.indexOf('async function handleSsoRecoverAtCommunity(');
        const handler = welcome.slice(at, welcome.indexOf('\n    }\n', at));
        expect(handler).toMatch(new RegExp([
            String.raw`const vault = hasVault\(\);`,
            String.raw`(?:\s*//.*)*`,
            String.raw`\s*if \(vault\) \{`,
            String.raw`\s*landNextOn\('/\(tabs\)/settings', result\.identity\.publicKey\);`,
            String.raw`(?:\s*//.*)*`,
            String.raw`\s*await recheckNodeStatus\(\)\.catch\(\(\) => \{\}\);`,
            String.raw`\s*\}`,
            String.raw`\s*setOutgoingIdentity\(null\);`,
            String.raw`\s*setIdentity\(result\.identity\);`,
            String.raw`\s*setMode\('home'\);`,
            String.raw`\s*if \(vault\) \{`,
        ].join('')));
        expect(handler).toMatch(/\} else \{\n\s*router\.replace\('\/'\);\n\s*\}/);
        expect(handler).not.toMatch(/router\.\w+\('\/\(tabs\)\/settings'/);
        expect(handler.match(/router\.(replace|push|navigate)\(/g)).toEqual(['router.replace(']);
    });

    it("app/_layout.tsx's guard: a stranger it holds on welcome lands where guestRedirect says, and only a chosen guest", () => {
        const layout = read('../../app/_layout.tsx');
        const at = layout.indexOf("        if (recognition === 'stranger') {");
        const branch = layout.slice(at, layout.indexOf("        if (recognition === 'member' && (root === 'node-mismatch'", at));
        const welcome = branch.slice(branch.indexOf("} else if (root === 'welcome') {"));
        expect(welcome).toMatch(new RegExp([
            String.raw`\} else if \(root === 'welcome'\) \{`,
            String.raw`(?:\s*//.*)*`,
            String.raw`\s*const publicKey = identity\.publicKey;`,
            String.raw`\s*void \(async \(\) => \{`,
            String.raw`\s*try \{`,
            String.raw`\s*const anchor = await AsyncStorage\.getItem\('beanpool_anchor_url'\);`,
            String.raw`\s*if \(!anchor\) return;`,
            String.raw`\s*const \{ isGuestNode \} = await import\('\.\./utils/nodes'\);`,
            String.raw`\s*if \(!\(await isGuestNode\(anchor\)\)\) return;`,
            String.raw`\s*\} catch \{`,
            String.raw`\s*return;`,
            String.raw`\s*\}`,
            String.raw`\s*const landing = guestRedirect\(segments as string\[\], publicKey\);`,
            String.raw`\s*if \(landing && isComponentMounted\.current\) router\.replace\(landing\);`,
            String.raw`\s*\}\)\(\);`,
            String.raw`\s*\}`,
            String.raw`\s*return;`,
        ].join('')));
        // Off any other screen a stranger is diverted as before: the else is the welcome screen's alone.
        expect(branch).toMatch(/if \(!notRecognisedStays\('stranger', segments as string\[\]\)\) \{/);
        expect(branch.match(/guestRedirect\(/g)).toHaveLength(1);
    });

    it('a guest visit to the global community asks for the tabs, and asks recognition again, before its bounce through Welcome', () => {
        const hook = read('../use-global-guest-visit.ts');
        expect(hook).toMatch(new RegExp([
            String.raw`if \(answer\.kind === 'member' \|\| answer\.kind === 'guest'\) \{`,
            String.raw`\s*if \(answer\.kind === 'guest'\) landNextOn\('/\(tabs\)', identity\.publicKey\);`,
            String.raw`\s*await recheck\(\)\.catch\(\(\) => 'unknown'\);`,
            String.raw`[^]*?if \(router\.canDismiss\(\)\) router\.dismissAll\(\);`,
            String.raw`\s*router\.replace\('/welcome'\);`,
        ].join('')));
        expect(hook.match(/landNextOn\(/g)).toHaveLength(1);
    });
});
