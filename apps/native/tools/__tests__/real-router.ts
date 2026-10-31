/**
 * expo-router's own routing, run under vitest: its real push, navigate, replace, back and setParams (global-state/routing.js),
 * its real path parser (fork/getStateFromPath.js), and its real route table built from the files in app/, over React
 * Navigation's real StackRouter. Only what needs a device is stubbed (react-native, expo-linking, the DOM-component bridge),
 * and the store is a small one that holds the stack as the app's root Stack does, under its `__root` route.
 *
 * Why it exists (Damo, 1 Nov): every tap in Your garden did nothing on Android, and no test could see it, because every suite
 * mocks `router` and only checks what was handed to it. A test that needs to know what a push really DOES takes this.
 *
 * The modules are read and run here rather than imported, because vitest can't reach into node_modules' CommonJS to swap
 * `require('react-native')`, and the real one does not load outside a device.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createContext } from 'react';
import { CommonActions, StackRouter, type NavigationAction } from '@react-navigation/routers';

const here = createRequire(import.meta.url);
const ER = path.dirname(here.resolve('expo-router/package.json'));
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');

export interface RealRoute { key: string; name: string; params?: Record<string, unknown> }
/** The route a screen is drawn for: what the test's useLocalSearchParams reads, as the real one reads its own route. */
export const RouteCtx = createContext<RealRoute | null>(null);

/** Every route file in app/, as the `require.context` Metro builds hands them to getRoutes. */
function appFiles(dir = APP, at = '.'): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
        ? appFiles(path.join(dir, e.name), `${at}/${e.name}`)
        : /\.tsx?$/.test(e.name) ? [`${at}/${e.name}`] : []));
}

export function createRealRouter(start: { name: string; params?: Record<string, unknown> }) {
    const store: Record<string, any> = {};
    const stubs: Record<string, unknown> = {
        'expo/dom': { IS_DOM: false },
        'expo-linking': {},
        'expo-modules-core': {},
        'react-native': { Platform: { OS: 'android' } },
        '@react-navigation/native': { validatePathConfig() {} },
        '../domComponents/emitDomEvent': {
            emitDomLinkEvent: () => false, emitDomDismiss: () => false, emitDomDismissAll: () => false, emitDomGoBack: () => false, emitDomSetParams: () => false,
        },
        './router-store': { store },
    };
    const loaded = new Map<string, { exports: any }>();
    const load = (file: string): any => {
        const had = loaded.get(file);
        if (had) return had.exports;
        const mod = { exports: {} as any };
        loaded.set(file, mod);
        const req = createRequire(file);
        const inner = (id: string): unknown => {
            if (id in stubs) return stubs[id];
            if (!id.startsWith('.')) return req(id);
            const target = req.resolve(id);
            return target.endsWith('.js') ? load(target) : req(target);
        };
        new Function('require', 'exports', 'module', fs.readFileSync(file, 'utf8'))(inner, mod.exports, mod);
        return mod.exports;
    };
    const fromRouter = (rel: string) => load(path.join(ER, 'build', rel));

    const files = appFiles();
    const context = Object.assign((id: string) => ({ default: () => null, id }), { keys: () => files, resolve: (id: string) => id, id: 'app' });
    const routes = fromRouter('getRoutes.js').getRoutes(context, { ignore: [/\/__tests__\//], skipGenerated: true });
    if (!routes) throw new Error('expo-router found no routes in app/');
    const config = { screens: { __root: { path: '', ...fromRouter('getReactNavigationConfig.js').getReactNavigationConfig(routes, true) } } };
    const routeNames = Object.keys(config.screens.__root.screens);

    const stackRouter = StackRouter({});
    const routeConfig = { routeNames, routeParamList: {}, routeGetIdList: {} };
    let opened = 0;
    const only = (route: { name: string; params?: Record<string, unknown> }) => ({ ...state, index: 0, routes: [{ key: `${route.name}-opened-${++opened}`, ...route }] });
    let state: any = stackRouter.getInitialState(routeConfig);
    state = only(start);
    const listeners = new Set<() => void>();
    const apply = (action: NavigationAction) => {
        const next = stackRouter.getStateForAction(state, action as any, routeConfig);
        if (next !== null && next !== state) { state = next; listeners.forEach((l) => l()); }
    };
    const top = (): RealRoute => state.routes[state.index];
    const ref = {
        current: {
            getRootState: () => ({ type: 'stack', key: 'root', index: 0, routeNames: ['__root'], routes: [{ key: '__root', name: '__root', state }] }),
            dispatch: apply,
            canGoBack: () => state.index > 0,
            setParams: (params: object) => apply({ ...CommonActions.setParams(params), source: top().key } as NavigationAction),
        },
    };
    Object.assign(store, {
        navigationRef: { current: ref.current, isReady: () => true },
        linking: { getStateFromPath: (href: string, cfg: unknown) => fromRouter('fork/getStateFromPath.js').getStateFromPath(href, cfg), config },
        redirects: [],
        getRouteInfo: () => ({ segments: [], pathname: '/', params: {}, unstable_globalHref: '/' }),
        get state() { return ref.current.getRootState(); },
    });

    const routing = fromRouter('global-state/routing.js');
    // The app's root runs the queue in an effect as soon as something is queued (useRoutingQueue): at once here.
    routing.routingQueue.subscribe(() => routing.routingQueue.run(ref));

    return {
        /** What the app imports as `router` from expo-router. */
        router: {
            push: routing.push, navigate: routing.navigate, replace: routing.replace, back: routing.goBack,
            canGoBack: routing.canGoBack, setParams: routing.setParams,
        },
        /** A link from outside, as the app opens one: the path's whole state taken as it stands, nothing through a push. */
        openLink(href: string) {
            const parsed = store.linking.getStateFromPath(href, config);
            const route = parsed.routes[0].state.routes.at(-1);
            state = only({ name: route.name, params: route.params });
            listeners.forEach((l) => l());
        },
        subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        snapshot: () => state,
        routes: (): RealRoute[] => state.routes,
        top,
    };
}
