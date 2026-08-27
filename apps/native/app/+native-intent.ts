import * as WebBrowser from 'expo-web-browser';

/**
 * Intercept incoming native deep links before Expo Router matches routes.
 * Completes WebBrowser auth sessions for OAuth callbacks (e.g. GitHub, Facebook)
 * and prevents unmatched route errors.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
    const isAuthCallback =
        path.includes('auth/github') ||
        path.includes('auth/facebook') ||
        path.startsWith('/auth/') ||
        path.startsWith('auth/');

    if (isAuthCallback) {
        try {
            WebBrowser.maybeCompleteAuthSession({ skipRedirectCheck: true });
        } catch (e) {
            console.warn('[NativeIntent] Failed to complete auth session:', e);
        }
        return '/';
    }

    return path;
}
