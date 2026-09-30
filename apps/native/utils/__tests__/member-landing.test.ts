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
import { DEFAULT_MEMBER_LANDING, landNextOn, memberRedirect } from '../member-landing';

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

describe('the model is the app', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

    it("app/_layout.tsx's guard ends by landing where memberRedirect says, and replaces to the tabs nowhere else from welcome", () => {
        const layout = read('../../app/_layout.tsx');
        const guard = layout.slice(layout.indexOf('        if (isLoading) return;\n        const root = (segments as string[])[0];'));
        const body = guard.slice(0, guard.indexOf('}, [identity, isLoading, segments, recognition, pendingOnboarding]);'));
        expect(body).toMatch(/\n\s*const landing = memberRedirect\(segments as string\[\]\);\n\s*if \(landing\) router\.replace\(landing\);\n\s*$/);
        expect(body).not.toMatch(/root === 'welcome'\) \{\s*router\.replace/);
    });

    it("app/welcome.tsx's community restore asks for Settings before setting the identity, and never navigates there itself", () => {
        const welcome = read('../../app/welcome.tsx');
        const at = welcome.indexOf('async function handleSsoRecoverAtCommunity(');
        const handler = welcome.slice(at, welcome.indexOf('\n    }\n', at));
        expect(handler).toMatch(new RegExp([
            String.raw`const vault = hasVault\(\);`,
            String.raw`(?:\s*//.*)*`,
            String.raw`\s*if \(vault\) landNextOn\('/\(tabs\)/settings'\);`,
            String.raw`\s*setOutgoingIdentity\(null\);`,
            String.raw`\s*setIdentity\(result\.identity\);`,
            String.raw`\s*setMode\('home'\);`,
            String.raw`\s*if \(vault\) \{`,
        ].join('')));
        expect(handler).toMatch(/\} else \{\n\s*router\.replace\('\/'\);\n\s*\}/);
        expect(handler).not.toMatch(/\(tabs\)\/settings'\)(?<!landNextOn\('\/\(tabs\)\/settings'\))/);
        expect(handler.match(/router\.(replace|push|navigate)\(/g)).toEqual(['router.replace(']);
    });
});
