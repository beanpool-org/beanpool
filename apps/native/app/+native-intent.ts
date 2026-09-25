import * as WebBrowser from 'expo-web-browser';
import { DeviceEventEmitter, Platform } from 'react-native';
import { linkRoutePath, isReturnFromSettings } from '../utils/settings-return';
import { postIdFromLink } from '../utils/event-extras';
import { isAuthReturnLink } from '../utils/auth-return';

/**
 * Intercept incoming native deep links before Expo Router matches routes.
 * Hands OAuth callbacks (e.g. Google, Facebook) to the waiting sign-in without navigating,
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
    const foregroundPath = linkRoutePath(path);

    // Node Settings' "Back to the BeanPool app" and "View my profile" (utils/settings-return.ts). On iOS
    // Settings is an SFSafariViewController presented inside the app, which would stay on top of wherever the
    // link lands; close it. (Android: our activity coming forward already backgrounds the Custom Tab.)
    if (Platform.OS === 'ios' && isReturnFromSettings(path)) {
        WebBrowser.dismissBrowser().catch(() => {});
    }

    if (foregroundPath === 'foreground') {
        // `null` cancels navigation, which keeps the member where they were — but only makes sense
        // once something is mounted. On a cold start there is no current route to stay on, so send
        // them home rather than leaving the stack with nothing.
        return initial ? '/' : null;
    }

    const isAuthCallback =
        path.includes('auth/github') ||
        path.includes('auth/facebook') ||
        path.includes('auth/google') ||
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

    // A sign-in provider's return (utils/auth-return.ts). The waiting sign-in takes it from the Linking event this
    // arrived on, or from the broadcast above; nothing more is needed. Navigating to app/auth/<provider> as well put a
    // screen over the one waiting for the sign-in, and every screen that reacts to navigation got a chance to disturb
    // it. So this works like the foreground link: the member stays where they are. On a cold start no sign-in can be
    // waiting, because the process that started it is gone, so the app opens as it does from its icon.
    if (isAuthReturnLink(path)) {
        return initial ? '/' : null;
    }

    // A shared event: `https://<node>/?post=<id>` (apps/native/utils/event-extras.ts). Path "/" is what the
    // app links claim on every node host, so a link a member sends from the event screen opens the event
    // here rather than the home tab. Last, and only when `post=` is actually in the URL, so the foreground
    // link, a Settings return, an invite and an OAuth callback all keep the behaviour they had.
    const sharedPostId = postIdFromLink(path);
    if (sharedPostId) return `/post/${encodeURIComponent(sharedPostId)}`;

    return path;
}
