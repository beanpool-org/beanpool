/**
 * How a tool's screen travels in the host route's params (app/tool/[id].tsx): as `toolScreen`, never as `screen`.
 *
 * `screen` is React Navigation's own word, for the child a param opens in a nested navigator, and expo-router takes it out
 * of every route it pushes, navigates to or replaces with (global-state/routing.js getPayloadFromStateRoute). A tap that
 * named its screen that way pushed the tool again with no screen, so its first screen came up over itself and the tap
 * seemed to do nothing (Damo, 1 Nov; tools/__tests__/tool-taps-real-router.test.ts runs the real push).
 *
 * A link from outside (`beanpool://tool/<id>?screen=…&key=…`, the shape docs and old notes give) reaches the route whole,
 * with no push, so {@link toolScreenOf} still reads `screen`.
 */
export const TOOL_SCREEN_PARAM = 'toolScreen';

/** The route's own params: every other one is the tool's (a record's `key`). */
const ROUTE_PARAMS = new Set(['id', 'screen', TOOL_SCREEN_PARAM]);

/** A tool, at a screen of its own when one is named, with the params the tool set, as `router.push` takes it. */
export function toolHref(id: string, screen?: string, params?: Readonly<Record<string, string>>) {
    return { pathname: '/tool/[id]' as const, params: { ...(params ?? {}), id, ...(screen ? { [TOOL_SCREEN_PARAM]: screen } : {}) } };
}

/** The same as a path (a reminder's tap hands the router a string). */
export function toolPath(id: string, screen?: string): string {
    return `/tool/${encodeURIComponent(id)}${screen ? `?${TOOL_SCREEN_PARAM}=${encodeURIComponent(screen)}` : ''}`;
}

/** The screen a route's params name, or '' for none: the tool opens on its first. */
export function toolScreenOf(all: Readonly<Record<string, string | string[] | undefined>>): string {
    for (const name of [TOOL_SCREEN_PARAM, 'screen']) {
        const named = all[name];
        if (typeof named === 'string' && named) return named;
    }
    return '';
}

/** The route's params as the tool sees them: every one but the route's own. */
export function toolParams(all: Readonly<Record<string, string | string[] | undefined>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) if (!ROUTE_PARAMS.has(k) && typeof v === 'string') out[k] = v;
    return out;
}
