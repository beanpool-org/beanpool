/**
 * The two links node Settings sends a member back to the app with (apps/manager/src/lib/came-from.ts builds
 * them when the page was opened with `#…&from=app`):
 *
 *   `beanpool://foreground`                       — "Back to the BeanPool app": the app comes forward and the
 *                                                   member stays on the screen they pressed Manage from.
 *   `beanpool://public-profile?publicKey=<hex>`   — "View my profile".
 *
 * Settings is open in an in-app browser (expo-web-browser's openBrowserAsync). On Android, opening our own
 * scheme brings our activity forward and backgrounds the Custom Tab. On iOS the SFSafariViewController is
 * presented INSIDE the app, so it stays on top of the screen the link lands on unless we dismiss it —
 * `+native-intent.ts` does that for these paths.
 */

/** `beanpool://foreground/?x#y` → `foreground`: scheme, query, fragment and slashes off. */
export function linkRoutePath(path: string): string {
    return path
        .replace(/^[a-zA-Z0-9_-]+:\/\//, '')
        .split('?')[0]
        .split('#')[0]
        .replace(/\/+$/, '')
        .replace(/^\//, '');
}

/** True for the links Settings uses to hand the member back; the in-app browser should close for them. */
export function isReturnFromSettings(path: string): boolean {
    const route = linkRoutePath(path);
    return route === 'foreground' || route === 'public-profile';
}
