import * as WebBrowser from 'expo-web-browser';
import { DeviceEventEmitter } from 'react-native';

/**
 * Intercept incoming native deep links before Expo Router matches routes.
 * Completes WebBrowser auth sessions for OAuth callbacks (e.g. GitHub, Facebook)
 * and prevents unmatched route errors.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
    // A no-op link whose only job is to bring the app to the front, backgrounding an Android
    // Custom Tab that nothing else can close (`WebBrowser.dismissBrowser` is iOS-only).
    //
    // Normalised rather than compared literally: Android intent resolvers and deep-link
    // normalisers add trailing slashes and query strings freely, and an exact match that missed
    // would fall through and navigate to a route that does not exist — an Unmatched Route screen
    // in place of the screen the member was on, which is worse than the problem being solved.
    const foregroundPath = path
        .replace(/^[a-zA-Z0-9_-]+:\/\//, '')
        .split('?')[0]
        .split('#')[0]
        .replace(/\/+$/, '')
        .replace(/^\//, '');
    if (foregroundPath === 'foreground') {
        // `null` cancels navigation, which keeps the member where they were — but only makes sense
        // once something is mounted. On a cold start there is no current route to stay on, so send
        // them home rather than leaving the stack with nothing.
        return initial ? '/' : null;
    }

    const isAuthCallback =
        path.includes('auth/github') ||
        path.includes('auth/facebook') ||
        path.includes('auth/tiktok') ||
        path.includes('auth/instagram') ||
        path.startsWith('/auth/') ||
        path.startsWith('auth/');

    if (isAuthCallback) {
        try {
            let fullUrl = path;
            if (!path.startsWith('http://') && !path.startsWith('https://') && !path.startsWith('beanpool://')) {
                fullUrl = `https://beanpool.org${path.startsWith('/') ? '' : '/'}${path}`;
            }
            DeviceEventEmitter.emit('SSO_AUTH_CALLBACK', fullUrl);
            // `maybeCompleteAuthSession` is web-only (@platform web) and takes no url — on Android the
            // deep link broadcast above is what actually completes the sign-in. Kept for the PWA.
            WebBrowser.maybeCompleteAuthSession({ skipRedirectCheck: true });
        } catch (e) {
            console.warn('[NativeIntent] Failed to complete auth session:', e);
        }
    }

    return path;
}
