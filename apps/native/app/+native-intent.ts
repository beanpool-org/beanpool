import * as WebBrowser from 'expo-web-browser';
import { DeviceEventEmitter } from 'react-native';

/**
 * Intercept incoming native deep links before Expo Router matches routes.
 * Completes WebBrowser auth sessions for OAuth callbacks (e.g. GitHub, Facebook)
 * and prevents unmatched route errors.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
    // A no-op link whose only job is to bring the app to the front, backgrounding an Android
    // Custom Tab that nothing else can close (`WebBrowser.dismissBrowser` is iOS-only). Returning
    // null cancels navigation, so the member stays on whatever screen they were already on.
    if (path === 'foreground' || path === '/foreground' || path.endsWith('://foreground')) {
        return null;
    }

    const isAuthCallback =
        path.includes('auth/github') ||
        path.includes('auth/facebook') ||
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
