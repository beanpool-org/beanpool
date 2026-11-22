/**
 * The navigation bar's colour on Android 8 and 9 (android/.../NavBarColourModule.kt says why): the app's own, so the bar
 * isn't a light grey strip with the page's words behind it in a dark set. From Android 10 (API 29) the bar is see-through
 * and nothing is done; iOS has none. A build without the module (the web build, a dev client from before it) keeps the
 * colour Android gives the bar.
 *
 * Read off globalThis.expo.modules, as modules/boot-clock/index.ts is and for its reason: ThemeContext, which most screens'
 * tests load, calls this, and expo-modules-core does not load in the node test runner.
 */
export const NAV_BAR_MODULE = 'BeanPoolNavBarColour';
/** The first Android whose navigation bar is see-through under React Native's edge to edge. */
export const CLEAR_NAV_BAR_API = 29;

type NavBar = { set(argb: number): Promise<void> };

/** A `#rrggbb` as Android's signed 32-bit colour, opaque; null for anything else (a see-through token is never a bar's). */
export function argbOf(hex: string): number | null {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    return m ? (0xff000000 | parseInt(m[1], 16)) : null;
}

/** Paints the bar `hex`, on an Android that needs it and a build that can. `api` is Platform.Version. */
export function paintNavBar(hex: string, api: number): void {
    if (!(api < CLEAR_NAV_BAR_API)) return;
    const argb = argbOf(hex);
    const bar = (globalThis as { expo?: { modules?: Record<string, NavBar | undefined> } }).expo?.modules?.[NAV_BAR_MODULE];
    if (argb === null || !bar) return;
    try {
        bar.set(argb).catch(() => { /* the bar keeps the colour it had */ });
    } catch { /* the same */ }
}
