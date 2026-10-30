// @vitest-environment jsdom
/**
 * Link a device from the phone's CAMERA app with BeanPool closed (a cold start). Damo, 23 Oct (test community, Android):
 * "it just opens the BeanPool app but nothing happens, no pin code or anything"; from inside the app it worked.
 *
 * Measured on the emulator (a dev client started by the link, Metro from this branch, log lines on the route):
 *   redirectSystemPath {"path":"beanpool://pair?session=…","initial":true}    the router got the whole link
 *   pair-device MOUNT; its link effect starts reading the code
 *   guard {"isLoading":false,"segments":[]}  →  landing "/(tabs)"            the root guard's first look
 *   guard {"segments":["pair-device"]}  →  null
 *   pair-device UNMOUNT; guard {"segments":["(tabs)"]}                         Home, and nothing else
 * On Android the router answers the start-up link asynchronously, so expo-router has no route info to give before the
 * container reports the state the root layout's navigator took (global-state/router-store.js: only a string initial URL
 * is prefetched, which iOS has and Android hasn't). The root layout draws its navigator only once the account and the
 * language are loaded, and in that same commit the guard read `useSegments()` as `[]`, the bare root's value, and landed
 * the member on the tabs over the pairing screen the link had opened.
 *
 * Modelled as member-landing.test.ts models expo-router 55 and @react-navigation/core 7 (its notes there), rendered
 * with the real React reconciler, plus a cold start: the container starts on the link's route, with no route info until
 * it reports, and the root layout draws nothing while it loads. The route a link opens is the real
 * app/+native-intent.ts's; the guard's landing is the real utils/member-landing.ts's, called as app/_layout.tsx does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createContext, createElement as h, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { emit: vi.fn() } }));
vi.mock('expo-web-browser', () => ({ dismissBrowser: vi.fn(async () => undefined), maybeCompleteAuthSession: vi.fn() }));

import { redirectSystemPath } from '../../app/+native-intent';
import { memberRedirect } from '../member-landing';

type Route = 'index' | 'welcome' | '(tabs)/index' | 'pair-device';

/** The expo-router href as the navigator resolves it. */
function resolve(href: string): Route {
    if (href === '/') return 'index';
    if (href === '/(tabs)') return '(tabs)/index';
    if (href === '/welcome') return 'welcome';
    if (/^\/pair-device\?qr=[0-9a-f]+$/.test(href)) return 'pair-device';
    throw new Error(`unmodelled href ${href}`);
}
/** `useSegments()` for a route: app/index.tsx is the bare root, `[]`. */
const SEGMENTS: Record<Route, string[]> = { index: [], welcome: ['welcome'], '(tabs)/index': ['(tabs)'], 'pair-device': ['pair-device'] };
/** expo-router's defaultRouteInfo: what `useSegments()` gives before the container has reported any state. */
const NO_ROUTE_YET: string[] = [];

const LINK = `beanpool://pair?session=${'a1'.repeat(16)}&pub=${'b2'.repeat(32)}&node=${encodeURIComponent('https://mullum.example')}`;

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

/** Starts the app cold on `href` (what the router made of the start-up link), and says where the member is once all has settled. */
async function coldStart(href: string): Promise<{ landed: Route; log: string[] }> {
    const log: string[] = [];

    // React Navigation's container: it starts on the start-up link's state, and reports a change in a passive effect, never
    // at its own first mount; the root navigator taking that state when it mounts is a change.
    let navState: Route = resolve(href);
    let version = 0;
    const navListeners = new Set<() => void>();
    const nav = {
        get: () => `${navState}#${version}`,
        subscribe: (cb: () => void) => { navListeners.add(cb); return () => { navListeners.delete(cb); }; },
        replace: (to: Route) => { log.push(`navigate ${to}`); navState = to; version++; navListeners.forEach((l) => l()); },
        hydrate: () => { version++; navListeners.forEach((l) => l()); },
    };
    // expo-router's store, on Android: no route info until the container reports (the start-up URL came as a promise).
    let routeInfo = NO_ROUTE_YET;
    const infoListeners = new Set<() => void>();
    const store = {
        subscribe: (cb: () => void) => { infoListeners.add(cb); return () => { infoListeners.delete(cb); }; },
        get: () => routeInfo,
        setFocused: (r: Route) => { routeInfo = SEGMENTS[r]; },
        onStateChange: (r: Route) => { routeInfo = SEGMENTS[r]; infoListeners.forEach((l) => l()); },
    };
    let queue: Route[] = [];
    const queueListeners = new Set<() => void>();
    const routing = {
        subscribe: (cb: () => void) => { queueListeners.add(cb); return () => { queueListeners.delete(cb); }; },
        snapshot: () => queue,
        add: (to: Route) => { queue = [...queue, to]; queueListeners.forEach((l) => l()); },
        run: () => { const events = queue; queue = []; for (const to of events) nav.replace(to); },
    };
    const router = { replace: (to: string) => { log.push(`router.replace(${to})`); routing.add(resolve(to)); } };

    type Id = { publicKey: string } | null;
    const NavState = createContext<Route>(navState);
    const Account = createContext<{ identity: Id; isLoading: boolean }>({ identity: null, isLoading: true });

    function RouterContainer({ children }: { children: ReactNode }) {
        const events = useSyncExternalStore(routing.subscribe, routing.snapshot);
        useEffect(() => { if (events.length) routing.run(); }, [events]);
        return h(NavigationContainer, null, children);
    }
    function NavigationContainer({ children }: { children: ReactNode }) {
        useSyncExternalStore(nav.subscribe, nav.get);
        const first = useRef(true);
        const state = navState;
        const reported = nav.get();
        useEffect(() => {
            if (!first.current) store.onStateChange(state);
            first.current = false;
        }, [reported]);
        return h(NavState.Provider, { value: state }, children);
    }
    /** The account is read from the phone after the first draw (IdentityContext), and the language with it. */
    function AccountProvider({ children }: { children: ReactNode }) {
        const [value, setValue] = useState<{ identity: Id; isLoading: boolean }>({ identity: null, isLoading: true });
        useEffect(() => { setTimeout(() => setValue({ identity: { publicKey: 'pk' }, isLoading: false }), 10); }, []);
        return h(Account.Provider, { value }, children);
    }
    /** app/_layout.tsx RootLayoutNav: nothing drawn while loading; its guard's last check, for a member (tied below). */
    function RootLayoutNav() {
        const { identity, isLoading } = useContext(Account);
        const segments = useSyncExternalStore(store.subscribe, store.get);
        useEffect(() => {
            if (isLoading || !identity) return;
            log.push(`guard ${JSON.stringify(segments)}`);
            const landing = memberRedirect(segments, identity.publicKey);
            if (landing) router.replace(landing);
        }, [identity, isLoading, segments]);
        if (isLoading) return null;
        return h(Stack);
    }
    /** The root navigator: mounting, it takes the container's state, which the container then reports. */
    function Stack() {
        const route = useContext(NavState);
        useLayoutEffect(() => { nav.hydrate(); }, []);
        return h(Screen, { key: route, route });
    }
    function Screen({ route }: { route: Route }) {
        store.setFocused(route);
        return route === 'index' ? h(Index) : h('div', null, route);
    }
    /** app/index.tsx: `<Redirect href="/welcome" />`, which replaces in an effect. */
    function Index() {
        useEffect(() => { router.replace('/welcome'); }, []);
        return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(h(RouterContainer, null, h(AccountProvider, null, h(RootLayoutNav))) as Parameters<Root['render']>[0]);
    // Flake cause: coldStart used a fixed 300 ms setTimeout which starved under load before AccountProvider's 10 ms timer and the guard effect cascade ran, leaving log empty.
    // Wait for the asynchronous account loading and guard effects to settle deterministically.
    await vi.waitFor(() => {
        if (href === '/') {
            expect(navState).toBe('(tabs)/index');
        } else {
            expect(log.length).toBeGreaterThanOrEqual(2);
        }
    }, { timeout: 15_000 });
    return { landed: navState, log };
}

/** Where the router opens for a start-up link: app/+native-intent.ts, at once (a pairing link is never answered later). */
function startUpRoute(link: string): string {
    const to = redirectSystemPath({ path: link, initial: true });
    if (typeof to !== 'string') throw new Error(`not routed at once: ${String(to)}`);
    return to;
}

describe('a cold start from the camera app: the pairing screen stays', () => {
    it("BeanPool closed, the web's QR scanned with the camera app: the pairing screen, not the tabs over it", async () => {
        const href = startUpRoute(LINK);
        expect(href).toMatch(/^\/pair-device\?qr=[0-9a-f]+$/);
        const { landed, log } = await coldStart(href);
        expect(log).not.toContain('router.replace(/(tabs))');
        expect(landed).toBe('pair-device');
        // The guard looked before the router had said where it was, then again once it had.
        expect(log).toEqual(['guard []', 'guard ["pair-device"]']);
    });

    it('opened from its icon, the app still lands a member on the tabs', async () => {
        const { landed, log } = await coldStart('/');
        expect(landed).toBe('(tabs)/index');
        expect(log).toContain('router.replace(/(tabs))');
    });

    it('the wait is for that start-up link only: once the router has shown it, the bare root lands on the tabs again', async () => {
        const { landed } = await coldStart(startUpRoute(LINK));
        expect(landed).toBe('pair-device');
        expect(memberRedirect([], 'pk')).toBe('/(tabs)');
        expect(memberRedirect(['welcome'], 'pk')).toBe('/(tabs)');
    });

    it('a pairing link opened while the app runs (not the start-up link) leaves the guard as it was', () => {
        expect(redirectSystemPath({ path: LINK, initial: false })).toMatch(/^\/pair-device\?qr=/);
        expect(memberRedirect([], 'pk')).toBe('/(tabs)');
    });

    it('other start-up links are not held: the app opened by its no-op link, or a sign-in return, lands as before', () => {
        expect(redirectSystemPath({ path: 'beanpool://foreground', initial: true })).toBe('/');
        expect(memberRedirect([], 'pk')).toBe('/(tabs)');
    });
});

describe('the model is the app', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

    it("app/_layout.tsx draws no navigator while loading, and its guard waits for the load, then lands where memberRedirect says", () => {
        const layout = read('../../app/_layout.tsx');
        expect(layout).toContain('const isLoading = identityLoading || !languageSettled;');
        expect(layout).toContain('if (isLoading || !appLockChecked) return null;');
        const guard = layout.slice(layout.indexOf('    useEffect(() => {\n        if (isLoading) return;\n        const root = (segments as string[])[0];'));
        // Since S3 the guard also looks again when the phone's community comes or goes (`noCommunity`, a waiting phone).
        const body = guard.slice(0, guard.indexOf('}, [identity, isLoading, segments, recognition, pendingOnboarding, noCommunity]);'));
        // Then, over the tabs' index only, a notice tapped from the community the phone has just moved to (#2436): nothing
        // else after the landing.
        expect(body).toMatch(/\n\s*const landing = memberRedirect\(segments as string\[\], identity\.publicKey\);\n\s*if \(landing\) router\.replace\(landing\);\n\s*const notice = landing === DEFAULT_MEMBER_LANDING \? takeOpenAfterLanding\(identity\.publicKey, nodeUrl\) : null;\n\s*if \(notice\) router\.push\(notice\);\n\s*$/);
    });

    it('app/index.tsx is the bare root, and sends to welcome', () => {
        expect(read('../../app/index.tsx')).toContain('<Redirect href="/welcome" />');
    });
});
