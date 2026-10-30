/**
 * A stack of screens run by the real StackRouter (the one expo-router's Stack runs on), for the cases that need to know what
 * is LEFT in the stack: a router.push adds a route, router.back pops the top, and a screen's own navigation.goBack() pops the
 * top too: react-navigation adds the screen's route as the action's `source` and no `target`, and the stack honours a source
 * only when the target is its own key. A screen that must take out its own copy dispatches a POP that names both. The
 * screens are the app's own, drawn one per route, each under its own route and navigation, as native-stack mounts them
 * (every route stays mounted while it is covered).
 */
import { createContext, createElement, useContext, useSyncExternalStore, type ComponentType, type ReactElement } from 'react';
import { CommonActions, StackActions, StackRouter, type NavigationAction } from '@react-navigation/routers';

export interface SimRoute { key: string; name: string; params?: Record<string, unknown> }
export interface SimNavigation {
    isFocused(): boolean;
    goBack(): void;
    dispatch(action: NavigationAction): void;
    getState(): { key: string; index: number; routes: SimRoute[] };
    addListener(): () => void;
}
/** The route a screen is drawn for, with its navigation; the stand-in useRoute, useNavigation and useLocalSearchParams read it. */
export const RouteCtx = createContext<{ route: SimRoute; navigation: SimNavigation } | null>(null);

const NAMES = ['index', 'new-listing', 'other'];

/** `/new-listing?newPost=offer`, `/(tabs)/map` or `{ pathname, params }` as a route name and params. */
function target(to: unknown): { name: string; params?: Record<string, unknown> } {
    const path = typeof to === 'string' ? to : String((to as { pathname: string }).pathname);
    const [pathname, query] = path.split('?');
    const params: Record<string, unknown> = { ...((to as { params?: Record<string, unknown> }).params ?? {}) };
    for (const [k, v] of new URLSearchParams(query ?? '')) params[k] = v;
    const name = pathname.replace(/^\/(\(tabs\)\/)?/, '');
    return { name: name === 'map' || name === '' ? 'index' : name, params };
}

export function createStack() {
    const router = StackRouter({});
    const config = { routeNames: NAMES, routeParamList: {}, routeGetIdList: {} };
    let state: any = router.getInitialState(config);
    const listeners = new Set<() => void>();
    const dispatch = (action: NavigationAction) => {
        const next = router.getStateForAction(state, action as any, config);
        if (next !== null && next !== state) { state = next; listeners.forEach((l) => l()); }
    };
    const navigationFor = (key: string): SimNavigation => ({
        isFocused: () => state.routes[state.index].key === key,
        // As react-navigation binds a screen's actions (useNavigationCache): this route is the source, and only the source.
        // The action's own `target` stays whatever the screen put on it.
        goBack: () => dispatch({ source: key, ...CommonActions.goBack() }),
        dispatch: (action) => dispatch({ source: key, ...action }),
        getState: () => state,
        addListener: () => () => {},
    });
    const stack = {
        /** The router stand-in: what expo-router's `router` does to the stack. */
        push: (to: unknown) => { const { name, params } = target(to); dispatch(StackActions.push(name, params)); },
        replace: (to: unknown) => { const { name, params } = target(to); dispatch(StackActions.replace(name, params)); },
        back: () => dispatch(CommonActions.goBack()),
        canGoBack: () => state.index > 0,
        canDismiss: () => state.index > 0,
        dismissAll: () => dispatch(StackActions.popToTop()),
        /** A screen opened over whatever is on top (a tool, a notification's screen). */
        pushOther: () => dispatch(StackActions.push('other')),
        names: (): string[] => state.routes.map((r: SimRoute) => r.name),
        keys: (): string[] => state.routes.map((r: SimRoute) => r.key),
        subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        snapshot: () => state,
        navigationFor,
        /** Every route drawn: its screen under its own route and navigation. */
        host: (screens: Record<string, ComponentType>): ReactElement => createElement(function StackHost() {
            const now = useSyncExternalStore(stack.subscribe, stack.snapshot);
            return createElement('div', { 'data-stack': stack.names().join(',') }, ...now.routes.map((route: SimRoute) => {
                const Screen = screens[route.name];
                return createElement(RouteCtx.Provider, { key: route.key, value: { route, navigation: navigationFor(route.key) } }, createElement(Screen));
            }));
        }),
    };
    return stack;
}
